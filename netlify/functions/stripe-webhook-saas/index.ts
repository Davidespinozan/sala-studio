import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '../_lib/env';
import { getStripe, Stripe } from '../_lib/stripe';
import { mapStripeStatusToEstado, cicloFromInterval } from '../_lib/saasBilling';

/**
 * POST /stripe-webhook-saas — Flujo 1 (SALA → gyms).
 * Sincroniza suscripciones_saas con el status autoritativo de Stripe.
 * Endpoint SEPARADO del webhook del socio (cada uno con su signing secret).
 *
 * Robustez (portado de healthyspaceclub):
 *  · firma verificada sobre el body CRUDO.
 *  · idempotencia por event.id (insert-or-ignore); ante error se borra el
 *    registro para que el retry de Stripe SÍ reprocese.
 *  · cuenta Stripe COMPARTIDA con HSC → ignora todo lo que no sea app:'sala'.
 *  · guard out-of-order con last_event_at.
 *  · past_due NO baja el acceso (gracia); enciende payment_past_due (dunning).
 */

// v22: current_period_end / trial_end pueden estar en la sub o en el item.
function epochToISO(epoch: unknown): string | null {
  return typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
}
function periodEndISO(sub: any): string | null {
  const item = sub?.items?.data?.[0];
  return epochToISO(sub?.current_period_end ?? item?.current_period_end ?? null);
}
function priceOf(sub: any): { id: string | null; interval: string | null; amount: number | null } {
  const price = sub?.items?.data?.[0]?.price ?? null;
  return {
    id: price?.id ?? null,
    interval: price?.recurring?.interval ?? null,
    amount: typeof price?.unit_amount === 'number' ? price.unit_amount : null
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const whSecret = requireEnv('STRIPE_WEBHOOK_SECRET_SAAS');
  if (!sig) return { statusCode: 400, body: 'Falta firma' };

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const stripe = getStripe();
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, whSecret);
  } catch (e) {
    console.error('[webhook-saas] firma inválida:', e instanceof Error ? e.message : e);
    return { statusCode: 400, body: 'Firma inválida' };
  }

  const admin = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ── Idempotencia: insert-or-ignore por event.id ──
  const { data: inserted, error: idemErr } = await admin
    .from('stripe_webhook_events')
    .upsert({ id: stripeEvent.id, type: stripeEvent.type }, { onConflict: 'id', ignoreDuplicates: true })
    .select('id');
  if (idemErr) {
    console.error('[webhook-saas] idempotencia falló:', idemErr.message);
    return { statusCode: 500, body: 'Error de idempotencia' };
  }
  if (!inserted || inserted.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
  }

  const eventAt = new Date(stripeEvent.created * 1000).toISOString();

  try {
    switch (stripeEvent.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object as any;
        // Cuenta compartida con HSC: solo lo nuestro.
        if (sub.metadata?.app !== 'sala') break;
        const tenantId: string | undefined = sub.metadata?.tenant_id;
        if (!tenantId) break;

        const deleted = stripeEvent.type === 'customer.subscription.deleted';
        const { id: priceId, interval, amount } = priceOf(sub);
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;

        const row: Record<string, unknown> = {
          tenant_id: tenantId,
          tier: sub.metadata?.tier,
          moneda: sub.metadata?.moneda,
          ciclo: sub.metadata?.ciclo ?? (interval ? cicloFromInterval(interval) : 'mensual'),
          estado: deleted ? 'cancelada' : mapStripeStatusToEstado(sub.status),
          stripe_customer_id: customerId,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          trial_termina: epochToISO(sub.trial_end),
          periodo_actual_termina: periodEndISO(sub),
          cancel_at_period_end: deleted ? false : (sub.cancel_at_period_end ?? false),
          payment_past_due: deleted ? false : sub.status === 'past_due',
          last_event_at: eventAt
        };
        if (typeof amount === 'number') row.precio_centavos = amount;

        await applyIfNewer(admin, tenantId, eventAt, row);
        break;
      }

      case 'invoice.payment_failed':
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const inv = stripeEvent.data.object as any;
        const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
        if (!customerId) break;
        // Filtro: ¿es de un tenant de SALA? (su customer está en suscripciones_saas)
        const { data: sus } = await admin
          .from('suscripciones_saas')
          .select('tenant_id, last_event_at')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (!sus?.tenant_id) break;
        if (sus.last_event_at && eventAt < sus.last_event_at) break;

        const pastDue = stripeEvent.type === 'invoice.payment_failed';
        await admin
          .from('suscripciones_saas')
          .update({ payment_past_due: pastDue, last_event_at: eventAt })
          .eq('tenant_id', sus.tenant_id);

        // Registrar el COBRO en el libro contable. Hasta acá el monto llegaba
        // en el evento y se descartaba: lo que SALA factura existía solo dentro
        // de Stripe, y no había forma de responder "cuánto cobré este mes".
        // Solo los pagos exitosos: un cobro fallido no es un movimiento de
        // dinero, es un cambio de estado (ya cubierto por payment_past_due).
        if (!pastDue) {
          const centavos = typeof inv.amount_paid === 'number' ? inv.amount_paid : 0;
          if (centavos > 0) {
            // La fecha del pago, no la del webhook: si Stripe reintenta la
            // entrega dos días después, el ingreso sigue perteneciendo al día
            // en que se cobró (y por lo tanto al mes correcto).
            const pagadoEn =
              typeof inv.status_transitions?.paid_at === 'number'
                ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
                : eventAt;

            const { error: errMov } = await admin.from('movimientos_dinero').insert({
              negocio: 'sala',
              ocurrido_en: pagadoEn,
              monto_centavos: centavos,
              moneda: (inv.currency || 'mxn').toUpperCase(),
              concepto: 'suscripcion',
              metodo: 'stripe',
              // Llave de idempotencia: Stripe reintenta, y sin esto cada
              // reintento sumaría el ingreso otra vez, en silencio.
              referencia_externa: inv.id,
              tenant_id: sus.tenant_id,
              metadata: {
                stripe_event: stripeEvent.id,
                stripe_subscription: typeof inv.subscription === 'string' ? inv.subscription : null,
                periodo_inicio: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
                periodo_fin: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
                numero_factura: inv.number ?? null
              }
            });

            // 23505 = ya estaba registrado. Es el caso ESPERADO en un reintento,
            // no un error: se ignora. Cualquier otro código sí se propaga, para
            // que Stripe reintente y el cobro no se pierda.
            if (errMov && errMov.code !== '23505') throw errMov;
          }
        }
        break;
      }

      default:
        break; // evento no manejado → 200
    }
  } catch (e) {
    console.error('[webhook-saas] error procesando', stripeEvent.type, ':', e instanceof Error ? e.message : e);
    // Borrar idempotencia → el retry de Stripe reprocesa (si no, saldría como duplicado).
    await admin.from('stripe_webhook_events').delete().eq('id', stripeEvent.id);
    return { statusCode: 500, body: 'Error de procesamiento' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// Upsert por tenant_id, respetando el orden de eventos (no piso datos más nuevos).
async function applyIfNewer(
  admin: SupabaseClient,
  tenantId: string,
  eventAt: string,
  row: Record<string, unknown>
): Promise<void> {
  const { data: existing } = await admin
    .from('suscripciones_saas')
    .select('last_event_at')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (existing?.last_event_at && eventAt < existing.last_event_at) return;

  await admin
    .from('suscripciones_saas')
    .upsert(row, { onConflict: 'tenant_id' });
}
