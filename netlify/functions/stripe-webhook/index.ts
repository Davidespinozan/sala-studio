import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws;
}

import type { Handler, HandlerResponse } from '@netlify/functions';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '../_lib/env';
import { getStripe, Stripe } from '../_lib/stripe';
import { reportarErrorServidor } from '../_lib/sentry';
import { inboxReceive, inboxClaim, inboxProcessed, inboxFailed } from '../_lib/stripeInbox';

/**
 * POST /stripe-webhook — Flujo 2 (gym → socios) vía Stripe Connect.
 *
 * W6-A2: transporte DURABLE por el inbox (A1). Pipeline:
 *   verify (FAIL-CLOSED) → filtro app:'sala' → receive → claim atómico →
 *   dispatcher (efecto + processed en una tx) → 200, o failed/dead + 500.
 * Sin fail-open, sin delete-on-error. Eventos duplicados = no-op idempotente.
 * El catálogo de eventos es el mismo de antes (A2 no lo amplía; refunds/disputes
 * = W6-C1). Cuenta compartida con HSC → se ignora todo lo que no sea app:'sala'.
 */

function epochToISO(epoch: unknown): string | null {
  return typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
}
function periodEndISO(sub: any): string | null {
  const item = sub?.items?.data?.[0];
  return epochToISO(sub?.current_period_end ?? item?.current_period_end ?? null);
}

/**
 * Tras guardar una tarjeta (checkout mode 'setup'): la fija como default y
 * reintenta la factura abierta → un socio en past_due se reactiva al toque
 * (el invoice.paid resultante fluye por el inbox). Idempotente.
 */
async function recuperarConNuevaTarjeta(stripe: Stripe, session: any, acct?: string): Promise<void> {
  if (!acct) return;
  const siId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (!siId || !customerId) return;
  const si = await stripe.setupIntents.retrieve(siId, {}, { stripeAccount: acct });
  const pmId = typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method as any)?.id;
  if (!pmId) return;
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pmId } }, { stripeAccount: acct });
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 }, { stripeAccount: acct });
  for (const sub of subs.data) {
    if ((sub.metadata as any)?.app !== 'sala') continue;
    if (!['active', 'past_due', 'trialing', 'unpaid'].includes(sub.status)) continue;
    await stripe.subscriptions.update(sub.id, { default_payment_method: pmId }, { stripeAccount: acct });
    const invRef = (sub as any).latest_invoice;
    const invId = typeof invRef === 'string' ? invRef : invRef?.id;
    if (!invId) continue;
    const inv = await stripe.invoices.retrieve(invId, {}, { stripeAccount: acct });
    if (inv.status === 'open') {
      try { await stripe.invoices.pay(invId, {}, { stripeAccount: acct }); }
      catch (e) { await reportarErrorServidor('webhook-socio', e, { fase: 'recuperar_pago', sub: sub.id }); }
    }
  }
}

interface Plan {
  kind: 'activar' | 'estado' | 'venta_online' | 'account' | 'card_recovery'
      | 'reembolso' | 'disputa' | 'sub_estado';   // W6-C1
  objectId: string | null;
  tenant: string | null;
  args: Record<string, unknown>;
  session?: any;                       // card_recovery
  notify?: { usuarioId: string };      // past_due
  notifyStaffDisputa?: boolean;        // W6-C1: alerta de contracargo abierto (best-effort)
}

// W6-C1: estado Stripe de la suscripción → estado canónico que acepta el writer
// (activa/past_due/cancelada). Estados sin efecto claro (trialing/incomplete)
// se ignoran: no forzamos un estado dudoso desde subscription.updated.
function estadoDeSub(s: string): string | null {
  if (s === 'active') return 'activa';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  if (s === 'canceled') return 'cancelada';
  return null;
}

/**
 * W6-C1b: todas las referencias con las que SALA pudo haber asentado un cargo.
 * La tienda guarda el PaymentIntent (pi_), pero las ALTAS guardan la Checkout
 * Session (cs_) y las RENOVACIONES la invoice (in_). Un refund/dispute solo trae
 * charge + payment_intent, así que se resuelven la sesión y la invoice (lecturas).
 * Si una lectura falla, se propaga → 500 → Stripe reintenta (nunca se pierde la
 * compensación por un fallo transitorio).
 */
async function referenciasDelCargo(
  stripe: Stripe, acct: string | undefined, chargeId: string | null, pi: string | null, invoiceEnPayload: unknown
): Promise<string[]> {
  const refs = new Set<string>();
  if (chargeId) refs.add(chargeId);
  if (pi) refs.add(pi);
  if (typeof invoiceEnPayload === 'string' && invoiceEnPayload) refs.add(invoiceEnPayload);
  if (pi && acct) {
    const sa = { stripeAccount: acct };
    const sesiones = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 }, sa);
    const cs = sesiones.data?.[0]?.id;
    if (cs) refs.add(cs);
    const pagosInvoice = await stripe.invoicePayments.list(
      { payment: { type: 'payment_intent', payment_intent: pi }, limit: 1 }, sa);
    const inv: any = pagosInvoice.data?.[0]?.invoice;
    const invId = typeof inv === 'string' ? inv : inv?.id;
    if (invId) refs.add(invId);
  }
  return [...refs];
}

/** Clasifica el evento y hace los retrieves de Stripe necesarios (lecturas). null = ignorar. */
async function clasificar(stripe: Stripe, ev: Stripe.Event, acct: string | undefined, eventCreatedISO: string): Promise<Plan | null> {
  const obj = ev.data.object as any;
  switch (ev.type) {
    case 'checkout.session.completed': {
      if (obj.metadata?.app !== 'sala') return null;
      if (obj.mode === 'setup') {
        return { kind: 'card_recovery', objectId: obj.id, tenant: null, args: { session_id: obj.id }, session: obj };
      }
      const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      let subId: string | null = null;
      let periodoFin: string | null = null;
      if (obj.mode === 'subscription') {
        subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
        if (subId && acct) { const sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: acct }); periodoFin = periodEndISO(sub); }
      }
      const inscripcion = Number(obj.metadata?.inscripcion_centavos ?? 0) || 0;
      const total = Number(obj.amount_total ?? 0) || 0;
      const montoPlan = Math.max(total - inscripcion, 0);
      return {
        kind: 'activar', objectId: obj.id, tenant: null,
        args: {
          usuario_id: obj.metadata?.usuario_id, tier_id: obj.metadata?.tier_id,
          stripe_subscription_id: subId, stripe_customer_id: customerId ?? null,
          periodo_fin: periodoFin, monto_centavos: montoPlan, referencia: obj.id, inscripcion_centavos: inscripcion
        }
      };
    }
    case 'customer.subscription.deleted': {
      if (obj.metadata?.app !== 'sala') return null;
      return { kind: 'estado', objectId: obj.id, tenant: null,
        args: { stripe_subscription_id: obj.id, nuevo_status: 'cancelada', event_created: eventCreatedISO, account_id: acct ?? null } };
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      if (obj.billing_reason !== 'subscription_cycle') return null;
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
      if (!subId || !acct) return null;
      const sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: acct });
      if ((sub.metadata as any)?.app !== 'sala') return null;
      const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id;
      return {
        kind: 'activar', objectId: obj.id, tenant: null,
        args: {
          usuario_id: (sub.metadata as any)?.usuario_id, tier_id: (sub.metadata as any)?.tier_id,
          stripe_subscription_id: subId, stripe_customer_id: customerId ?? null,
          periodo_fin: periodEndISO(sub), monto_centavos: Number(obj.amount_paid ?? 0) || 0,
          referencia: obj.id, inscripcion_centavos: 0
        }
      };
    }
    case 'invoice.payment_failed': {
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
      if (!subId || !acct) return null;
      const sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: acct });
      if ((sub.metadata as any)?.app !== 'sala') return null;
      const usuarioId = (sub.metadata as any)?.usuario_id;
      return {
        kind: 'estado', objectId: subId, tenant: null,
        args: { stripe_subscription_id: subId, nuevo_status: 'past_due', event_created: eventCreatedISO, account_id: acct },
        notify: usuarioId ? { usuarioId } : undefined
      };
    }
    case 'payment_intent.succeeded': {
      if (obj?.metadata?.app !== 'sala' || obj?.metadata?.tipo !== 'tienda') return null;
      let items: unknown = [];
      try { items = JSON.parse(obj.metadata.items ?? '[]'); } catch { items = []; }
      if (!Array.isArray(items) || items.length === 0) return null;
      return {
        kind: 'venta_online', objectId: obj.id, tenant: obj.metadata.tenant_id ?? null,
        args: {
          tenant_id: obj.metadata.tenant_id, usuario_id: obj.metadata.usuario_id,
          sucursal_id: obj.metadata.sucursal_id ?? null, items, referencia: obj.id,
          entrega_tipo: obj.metadata.entrega_tipo, entrega_ubicacion: obj.metadata.entrega_ubicacion ?? null
        }
      };
    }
    case 'account.updated': {
      if (!obj?.id) return null;
      return { kind: 'account', objectId: obj.id, tenant: null,
        args: { account_id: obj.id, charges: obj.charges_enabled === true, details: obj.details_submitted === true } };
    }

    // ── W6-C1: REEMBOLSOS ── cada refund individual por refund.id (parciales/
    //    múltiples). Ownership la resuelve el dispatcher (account→tenant + pago). ──
    case 'charge.refunded': {
      const refunds = ((obj.refunds?.data ?? []) as any[])
        .map((r) => ({ refund_id: r.id, amount: r.amount, moneda: r.currency, created: r.created ?? null }))
        .filter((r) => r.refund_id);
      if (refunds.length === 0) return null;
      const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id ?? null;
      const refs = await referenciasDelCargo(stripe, acct, obj.id, pi, obj.invoice);
      return { kind: 'reembolso', objectId: obj.id, tenant: null,
        args: { account_id: acct ?? null, charge_id: obj.id, payment_intent: pi, refs, refunds } };
    }

    // ── W6-C1: DISPUTAS ── created=abierta (+alerta); closed=won/lost. ──
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id ?? null;
      const chg = typeof obj.charge === 'string' ? obj.charge : obj.charge?.id ?? null;
      const estado = ev.type === 'charge.dispute.created'
        ? 'abierta'
        : (obj.status === 'won' ? 'ganada' : obj.status === 'lost' ? 'perdida' : 'abierta');
      const refs = await referenciasDelCargo(stripe, acct, chg, pi, null);
      return {
        kind: 'disputa', objectId: obj.id, tenant: null,
        args: { account_id: acct ?? null, dispute_id: obj.id, charge_id: chg, payment_intent: pi, refs,
                estado, amount: obj.amount ?? null, moneda: obj.currency ?? null },
        notifyStaffDisputa: estado === 'abierta'
      };
    }

    // ── W6-C1: subscription.updated ── SOLO estado contractual; NUNCA crea cobro.
    //    El dinero real del upgrade entra por invoice/payment (arriba). ──
    case 'customer.subscription.updated': {
      if (obj.metadata?.app !== 'sala') return null;
      const nuevo = estadoDeSub(obj.status);
      if (!nuevo) return null;
      return { kind: 'sub_estado', objectId: obj.id, tenant: null,
        args: { stripe_subscription_id: obj.id, nuevo_status: nuevo, event_created: eventCreatedISO, account_id: acct ?? null } };
    }

    default:
      return null;
  }
}

async function notificarPastDue(admin: SupabaseClient, usuarioId: string): Promise<void> {
  const { data: socio } = await admin.from('usuarios').select('tenant_id, nombre, email').eq('id', usuarioId).maybeSingle();
  if (!socio?.tenant_id) return;
  await admin.from('notificaciones').insert({
    tenant_id: socio.tenant_id, usuario_id: usuarioId, tipo: 'pago_rechazado',
    titulo: 'No pudimos cobrar tu plan',
    mensaje: 'Tu tarjeta fue rechazada. Actualizala desde tu perfil para no perder el acceso.'
  });
  await admin.rpc('notificar_staff' as never, {
    p_tenant_id: socio.tenant_id, p_tipo: 'pago_rechazado', p_titulo: 'Cobro rechazado',
    p_mensaje: `Le falló el cobro a ${socio.nombre ?? socio.email ?? 'un socio'}.`,
    p_metadata: { usuario_id: usuarioId }
  } as never);
}

// W6-C1: avisa al staff que se abrió un contracargo. Best-effort (reusa
// notificar_staff). Resuelve el tenant por la cuenta Connect del evento.
async function notificarDisputaStaff(admin: SupabaseClient, acct: string | undefined): Promise<void> {
  if (!acct) return;
  const { data: tenant } = await admin.from('tenants').select('id').eq('stripe_account_id', acct).maybeSingle();
  if (!tenant?.id) return;
  await admin.rpc('notificar_staff' as never, {
    p_tenant_id: tenant.id, p_tipo: 'contracargo', p_titulo: 'Contracargo abierto',
    p_mensaje: 'Un socio abrió una disputa de pago en su banco. Revisá el caso en Stripe.',
    p_metadata: {}
  } as never);
}

const OK: HandlerResponse = { statusCode: 200, body: JSON.stringify({ received: true }) };
const TIENDA_PERMANENTE = /SIN_STOCK|PRODUCTO_INVALIDO|ENTREGA_INVALIDA|SIN_ITEMS/;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  // FAIL-CLOSED: sin secreto no se autentica el evento → 500 (Stripe reintenta), NUNCA 200.
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET_SOCIO;
  if (!whSecret) {
    await reportarErrorServidor('webhook-socio', new Error('STRIPE_WEBHOOK_SECRET_SOCIO no configurado'));
    return { statusCode: 500, body: 'webhook secret no configurado' };
  }
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!sig) return { statusCode: 400, body: 'Falta firma' };

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const stripe = getStripe();
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, whSecret);
  } catch (e) {
    await reportarErrorServidor('webhook-socio', e, { fase: 'firma' });
    return { statusCode: 400, body: 'Firma inválida' };
  }

  const admin = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const acct = (stripeEvent as unknown as { account?: string }).account;
  const eventCreatedISO = new Date(stripeEvent.created * 1000).toISOString();

  let plan: Plan | null;
  try {
    plan = await clasificar(stripe, stripeEvent, acct, eventCreatedISO);
  } catch (e) {
    // Falló un retrieve de Stripe (transitorio): nada en el inbox aún → 500, Stripe reintenta.
    await reportarErrorServidor('webhook-socio', e, { fase: 'clasificar', event: stripeEvent.id, type: stripeEvent.type });
    return { statusCode: 500, body: 'Error temporal' };
  }
  if (!plan) return OK; // no es nuestro / evento no manejado → no-op

  await inboxReceive(admin, {
    id: stripeEvent.id, flujo: 'socio', type: stripeEvent.type, account: acct ?? null,
    tenant: plan.tenant, objectId: plan.objectId, created: eventCreatedISO, payload: plan.args
  });
  const { claimed } = await inboxClaim(admin, stripeEvent.id);
  if (!claimed) return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };

  try {
    if (plan.kind === 'card_recovery') {
      await recuperarConNuevaTarjeta(stripe, plan.session, acct);
      await inboxProcessed(admin, stripeEvent.id);
    } else {
      const { data: despacho, error } = await admin.rpc('stripe_procesar_socio' as never, {
        p_event_id: stripeEvent.id, p_kind: plan.kind, p_args: plan.args
      } as never);
      if (error) throw new Error((error as { message?: string }).message ?? String(error));
      // W6-C1b: un reembolso/contracargo sin contraparte interna NO se inventa,
      // pero tampoco se pierde en silencio: queda reportado para revisión.
      if ((despacho as { sin_pago?: boolean } | null)?.sin_pago === true) {
        await reportarErrorServidor('webhook-socio',
          new Error(`${plan.kind} de Stripe sin pago interno que compensar`),
          { event: stripeEvent.id, type: stripeEvent.type, object: plan.objectId }).catch(() => undefined);
      }
      if (plan.notify) {
        await notificarPastDue(admin, plan.notify.usuarioId).catch((e) =>
          reportarErrorServidor('webhook-socio', e, { fase: 'notificar', event: stripeEvent.id }));
      }
      // W6-C1: alerta de contracargo abierto. Best-effort y DESPUÉS de que el
      // dispatcher commiteó: un fallo del push NO revierte el estado durable de
      // la disputa (ya persistida + processed en la tx anterior).
      if (plan.notifyStaffDisputa) {
        await notificarDisputaStaff(admin, acct).catch((e) =>
          reportarErrorServidor('webhook-socio', e, { fase: 'notificar-disputa', event: stripeEvent.id }));
      }
    }
    return OK;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (plan.kind === 'venta_online' && TIENDA_PERMANENTE.test(msg)) {
      // Cobrado pero no registrable (stock/producto): no reprocesar. Marcar processed + alertar fuerte.
      await inboxProcessed(admin, stripeEvent.id);
      await reportarErrorServidor('webhook-socio', new Error('tienda cobrada pero NO registrada: ' + msg), { event: stripeEvent.id });
      return OK;
    }
    const estado = await inboxFailed(admin, stripeEvent.id, e);
    await reportarErrorServidor('webhook-socio', e, { event: stripeEvent.id, type: stripeEvent.type, estado });
    return { statusCode: 500, body: 'Error de procesamiento' };
  }
};
