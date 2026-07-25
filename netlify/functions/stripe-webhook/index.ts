import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { requireEnv } from '../_lib/env';
import { getStripe, Stripe } from '../_lib/stripe';

/**
 * POST /stripe-webhook — Flujo 2 (gym → socios) vía Stripe Connect.
 * Endpoint configurado en Stripe para escuchar eventos de CUENTAS CONECTADAS
 * (cada evento trae `event.account` = la cuenta del gym). Materializa la
 * membresía del socio con activar_suscripcion_socio (la MISMA RPC que el demo).
 *
 * Robustez: firma sobre el body crudo, idempotencia por event.id (tabla
 * compartida), filtro app:'sala'. Inerte sin STRIPE_WEBHOOK_SECRET_SOCIO.
 */

function epochToISO(epoch: unknown): string | null {
  return typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
}
function periodEndISO(sub: any): string | null {
  const item = sub?.items?.data?.[0];
  return epochToISO(sub?.current_period_end ?? item?.current_period_end ?? null);
}

/**
 * Tras guardar una tarjeta (checkout mode 'setup'): la fija como default del
 * customer y de sus suscripciones 'sala' vigentes, y reintenta la factura
 * abierta. Así un socio en past_due se reactiva al toque. Si el reintento falla,
 * invoice.payment_failed mantiene past_due (no rompemos el webhook).
 */
async function recuperarConNuevaTarjeta(stripe: Stripe, session: any, acct?: string): Promise<void> {
  if (!acct) return;
  const siId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (!siId || !customerId) return;

  const si = await stripe.setupIntents.retrieve(siId, {}, { stripeAccount: acct });
  const pmId = typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method as any)?.id;
  if (!pmId) return;

  // Default del customer (facturas futuras).
  await stripe.customers.update(
    customerId,
    { invoice_settings: { default_payment_method: pmId } },
    { stripeAccount: acct }
  );

  const subs = await stripe.subscriptions.list(
    { customer: customerId, status: 'all', limit: 10 },
    { stripeAccount: acct }
  );
  for (const sub of subs.data) {
    if ((sub.metadata as any)?.app !== 'sala') continue;
    if (!['active', 'past_due', 'trialing', 'unpaid'].includes(sub.status)) continue;

    await stripe.subscriptions.update(sub.id, { default_payment_method: pmId }, { stripeAccount: acct });

    const invRef = (sub as any).latest_invoice;
    const invId = typeof invRef === 'string' ? invRef : invRef?.id;
    if (!invId) continue;
    const inv = await stripe.invoices.retrieve(invId, {}, { stripeAccount: acct });
    if (inv.status === 'open') {
      try {
        // El pago exitoso dispara invoice.paid → el handler reactiva la membresía.
        await stripe.invoices.pay(invId, {}, { stripeAccount: acct });
      } catch (e) {
        console.error('[webhook-socio] reintento de factura falló:', e instanceof Error ? e.message : e);
      }
    }
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET_SOCIO;
  if (!whSecret) return { statusCode: 200, body: JSON.stringify({ skipped: 'stripe_no_configurado' }) };
  if (!sig) return { statusCode: 400, body: 'Falta firma' };

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const stripe = getStripe();
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, whSecret);
  } catch (e) {
    console.error('[webhook-socio] firma inválida:', e instanceof Error ? e.message : e);
    return { statusCode: 400, body: 'Firma inválida' };
  }

  const admin = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Idempotencia (tabla compartida con el webhook del SaaS).
  const { data: inserted, error: idemErr } = await admin
    .from('stripe_webhook_events')
    .upsert({ id: stripeEvent.id, type: stripeEvent.type }, { onConflict: 'id', ignoreDuplicates: true })
    .select('id');
  if (idemErr) return { statusCode: 500, body: 'Error de idempotencia' };
  if (!inserted || inserted.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
  }

  // La cuenta conectada del gym (Connect manda event.account).
  const acct = (stripeEvent as any).account as string | undefined;

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object as any;
        if (session.metadata?.app !== 'sala') break;

        // Guardado de tarjeta (mode 'setup'): promover el nuevo método de pago a
        // default del customer + de la suscripción y reintentar la factura
        // vencida → un socio en past_due recupera acceso al instante (sin esperar
        // el reintento automático de Stripe).
        if (session.mode === 'setup') {
          await recuperarConNuevaTarjeta(stripe, session, acct);
          break;
        }

        const usuarioId = session.metadata?.usuario_id;
        const tierId = session.metadata?.tier_id;
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        if (!usuarioId || !tierId) break;

        // Suscripción (mensualidad) → traemos la sub para el periodo. Pago único
        // (paquete) → sin sub ni periodo: la RPC calcula la vigencia del tier.
        let subId: string | null = null;
        let periodoFin: string | null = null;
        if (session.mode === 'subscription') {
          subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
          if (subId && acct) {
            const sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: acct });
            periodoFin = periodEndISO(sub);
          }
        }

        // Dinero real de este cobro. El total incluye la inscripción (segundo
        // line_item), así que se separa para registrar cada concepto por su lado.
        const inscripcion = Number(session.metadata?.inscripcion_centavos ?? 0) || 0;
        const total = Number(session.amount_total ?? 0) || 0;
        const montoPlan = Math.max(total - inscripcion, 0);

        const { error } = await admin.rpc('activar_suscripcion_socio', {
          p_usuario_id: usuarioId,
          p_tier_id: tierId,
          p_stripe_subscription_id: subId,
          p_stripe_customer_id: customerId ?? null,
          p_periodo_fin: periodoFin,
          p_monto_centavos: montoPlan,
          p_referencia: session.id,
          p_inscripcion_centavos: inscripcion
        });
        if (error) throw error;
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object as any;
        if (sub.metadata?.app !== 'sala') break;
        // Marcar la membresía cancelada (la creó activar_suscripcion_socio con este id).
        await admin
          .from('membresias')
          .update({ status: 'cancelada', cancelada_at: new Date(stripeEvent.created * 1000).toISOString() })
          .eq('stripe_subscription_id', sub.id);
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        // RENOVACIÓN mensual de la suscripción del socio. El primer cobro
        // (subscription_create) lo maneja checkout.session.completed → acá solo
        // los ciclos siguientes: refrescamos créditos/periodo vía la misma RPC.
        const inv = stripeEvent.data.object as any;
        if (inv.billing_reason !== 'subscription_cycle') break;
        const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
        if (!subId || !acct) break;
        const sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: acct });
        if ((sub.metadata as any)?.app !== 'sala') break;
        const usuarioId = (sub.metadata as any)?.usuario_id;
        const tierId = (sub.metadata as any)?.tier_id;
        const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id;
        if (!usuarioId || !tierId) break;
        const { error } = await admin.rpc('activar_suscripcion_socio', {
          p_usuario_id: usuarioId,
          p_tier_id: tierId,
          p_stripe_subscription_id: subId,
          p_stripe_customer_id: customerId ?? null,
          p_periodo_fin: periodEndISO(sub),
          // Renovación: solo el plan (la inscripción se cobró una única vez).
          p_monto_centavos: Number(inv.amount_paid ?? 0) || 0,
          p_referencia: inv.id,
          p_inscripcion_centavos: 0
        });
        if (error) throw error;
        break;
      }

      case 'invoice.payment_failed': {
        // Pago de renovación falló → past_due (dunning). Stripe reintenta solo.
        const inv = stripeEvent.data.object as any;
        const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
        if (!subId || !acct) break;
        const sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: acct });
        if ((sub.metadata as any)?.app !== 'sala') break;
        await admin.from('membresias').update({ status: 'past_due' }).eq('stripe_subscription_id', subId);

        // AVISAR. Antes esto pasaba en SILENCIO: el socio perdía el acceso sin
        // enterarse (solo lo veía si entraba a su perfil) y el gym tampoco sabía
        // que tenía un cobro caído. El push sale solo vía cron-push.
        const usuarioId = (sub.metadata as any)?.usuario_id;
        if (usuarioId) {
          const { data: socio } = await admin
            .from('usuarios')
            .select('tenant_id, nombre, email')
            .eq('id', usuarioId)
            .maybeSingle();

          if (socio?.tenant_id) {
            await admin.from('notificaciones').insert({
              tenant_id: socio.tenant_id,
              usuario_id: usuarioId,
              tipo: 'pago_rechazado',
              titulo: 'No pudimos cobrar tu plan',
              mensaje: 'Tu tarjeta fue rechazada. Actualizala desde tu perfil para no perder el acceso.'
            });

            await admin.rpc('notificar_staff', {
              p_tenant_id: socio.tenant_id,
              p_tipo: 'pago_rechazado',
              p_titulo: 'Cobro rechazado',
              p_mensaje: `Le falló el cobro a ${socio.nombre ?? socio.email ?? 'un socio'}.`,
              p_metadata: { usuario_id: usuarioId }
            });
          }
        }
        break;
      }

      case 'payment_intent.succeeded': {
        // Red de seguridad de la TIENDA: el cobro del socio lo asienta la función
        // comprar-producto de forma síncrona; esto solo cubre el hueco de que la
        // función muriera entre cobrar y registrar. registrar_venta_online es
        // idempotente por el id del PaymentIntent, así que reintentar es inocuo.
        const pi = stripeEvent.data.object as any;
        if (pi?.metadata?.app !== 'sala' || pi?.metadata?.tipo !== 'tienda') break;

        let items: unknown = [];
        try { items = JSON.parse(pi.metadata.items ?? '[]'); } catch { items = []; }
        // Carrito que no cupo en el metadata → el registro síncrono ya lo hizo;
        // no hay nada que re-armar acá.
        if (!Array.isArray(items) || items.length === 0) break;

        const { error } = await admin.rpc('registrar_venta_online', {
          p_tenant_id: pi.metadata.tenant_id,
          p_usuario_id: pi.metadata.usuario_id,
          p_sucursal_id: pi.metadata.sucursal_id ?? null,
          p_items: items,
          p_referencia: pi.id,
          p_entrega_tipo: pi.metadata.entrega_tipo,
          p_entrega_ubicacion: pi.metadata.entrega_ubicacion ?? null
        });
        if (error) {
          // Permanente (se agotó entre el cobro y este reintento, producto
          // inválido, etc.): no reventamos el webhook — reintentar no lo arregla.
          // El dinero está cobrado; queda MUY visible para resolver a mano.
          if (/SIN_STOCK|PRODUCTO_INVALIDO|ENTREGA_INVALIDA|SIN_ITEMS/.test(error.message)) {
            console.error('[webhook-socio] tienda cobrada pero NO registrada pi=', pi.id, error.message);
            break;
          }
          throw error; // transitorio → que Stripe reintente
        }
        break;
      }

      case 'account.updated': {
        // El estado de la cuenta conectada del gym cambió (verificación, etc.) →
        // mantenemos charges_enabled/details_submitted frescos en tenants. El
        // .eq por stripe_account_id ya scopea a nuestros tenants.
        const account = stripeEvent.data.object as any;
        if (!account?.id) break;
        await admin
          .from('tenants')
          .update({
            stripe_charges_enabled: account.charges_enabled === true,
            stripe_details_submitted: account.details_submitted === true
          })
          .eq('stripe_account_id', account.id);
        break;
      }

      default:
        break;
    }
  } catch (e) {
    console.error('[webhook-socio] error', stripeEvent.type, ':', e instanceof Error ? e.message : e);
    await admin.from('stripe_webhook_events').delete().eq('id', stripeEvent.id);
    return { statusCode: 500, body: 'Error de procesamiento' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
