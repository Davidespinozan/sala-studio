import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { requireEnv } from '../_lib/env';
import { getStripe, Stripe } from '../_lib/stripe';
import { mapStripeStatusToEstado, cicloFromInterval } from '../_lib/saasBilling';
import { reportarErrorServidor } from '../_lib/sentry';
import { inboxReceive, inboxClaim, inboxFailed } from '../_lib/stripeInbox';

/**
 * POST /stripe-webhook-saas — Flujo 1 (SALA → gyms).
 *
 * W6-A2: transporte DURABLE por el inbox (A1). verify (FAIL-CLOSED) → app:'sala'
 * → receive → claim → dispatcher stripe_procesar_saas (efecto + processed en una
 * tx: applyIfNewer + módulo + movimientos, preservando cortesía/orden/idempotencia)
 * → 200, o failed/dead + 500. Sin delete-on-error. Sin ampliar el catálogo.
 */

function epochToISO(epoch: unknown): string | null {
  return typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
}
function periodEndISO(sub: any): string | null {
  const item = sub?.items?.data?.[0];
  return epochToISO(sub?.current_period_end ?? item?.current_period_end ?? null);
}
function esTienda(item: any): boolean {
  const p = item?.price;
  return typeof p?.lookup_key === 'string' ? p.lookup_key.startsWith('sala_tienda') : p?.metadata?.addon === 'tienda';
}
function itemBase(sub: any): any {
  const items = sub?.items?.data ?? [];
  return items.find((i: any) => !esTienda(i)) ?? items[0] ?? null;
}
function priceOf(sub: any): { id: string | null; interval: string | null; amount: number | null } {
  const price = itemBase(sub)?.price ?? null;
  return {
    id: price?.id ?? null,
    interval: price?.recurring?.interval ?? null,
    amount: typeof price?.unit_amount === 'number' ? price.unit_amount : null
  };
}

interface Plan { kind: 'sub' | 'invoice'; objectId: string | null; tenant: string | null; args: Record<string, unknown>; }

function clasificar(ev: Stripe.Event, eventAt: string): Plan | null {
  const obj = ev.data.object as any;
  switch (ev.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (obj.metadata?.app !== 'sala') return null;
      const tenantId: string | undefined = obj.metadata?.tenant_id;
      if (!tenantId) return null;
      const deleted = ev.type === 'customer.subscription.deleted';
      const { id: priceId, interval, amount } = priceOf(obj);
      const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      const items: any[] = obj?.items?.data ?? [];
      const tiendaViva = !deleted && ['active', 'trialing', 'past_due'].includes(obj.status) && items.some(esTienda);
      return {
        kind: 'sub', objectId: obj.id, tenant: tenantId,
        args: {
          tenant_id: tenantId, tier: obj.metadata?.tier, moneda: obj.metadata?.moneda,
          ciclo: obj.metadata?.ciclo ?? (interval ? cicloFromInterval(interval) : 'mensual'),
          estado: deleted ? 'cancelada' : mapStripeStatusToEstado(obj.status),
          stripe_customer_id: customerId, stripe_subscription_id: obj.id, stripe_price_id: priceId,
          trial_termina: epochToISO(obj.trial_end), periodo_actual_termina: periodEndISO(obj),
          cancel_at_period_end: deleted ? false : (obj.cancel_at_period_end ?? false),
          payment_past_due: deleted ? false : obj.status === 'past_due',
          precio_centavos: typeof amount === 'number' ? amount : null,
          event_at: eventAt, tienda_viva: tiendaViva
        }
      };
    }
    case 'invoice.payment_failed':
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (!customerId) return null;
      const pastDue = ev.type === 'invoice.payment_failed';
      const pagadoEn = typeof obj.status_transitions?.paid_at === 'number'
        ? new Date(obj.status_transitions.paid_at * 1000).toISOString() : eventAt;
      return {
        kind: 'invoice', objectId: obj.id, tenant: null,
        args: {
          stripe_customer_id: customerId, event_at: eventAt, past_due: pastDue,
          amount_paid: pastDue ? 0 : (typeof obj.amount_paid === 'number' ? obj.amount_paid : 0),
          moneda: (obj.currency || 'mxn'), referencia_externa: obj.id, pagado_en: pagadoEn,
          metadata: {
            stripe_event: ev.id,
            stripe_subscription: typeof obj.subscription === 'string' ? obj.subscription : null,
            periodo_inicio: obj.period_start ? new Date(obj.period_start * 1000).toISOString() : null,
            periodo_fin: obj.period_end ? new Date(obj.period_end * 1000).toISOString() : null,
            numero_factura: obj.number ?? null
          }
        }
      };
    }
    default:
      return null;
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const whSecret = process.env.STRIPE_WEBHOOK_SECRET_SAAS;
  if (!whSecret) {
    await reportarErrorServidor('webhook-saas', new Error('STRIPE_WEBHOOK_SECRET_SAAS no configurado'));
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
    await reportarErrorServidor('webhook-saas', e, { fase: 'firma' });
    return { statusCode: 400, body: 'Firma inválida' };
  }

  const admin = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const eventAt = new Date(stripeEvent.created * 1000).toISOString();

  const plan = clasificar(stripeEvent, eventAt);
  if (!plan) return { statusCode: 200, body: JSON.stringify({ received: true }) };

  await inboxReceive(admin, {
    id: stripeEvent.id, flujo: 'saas', type: stripeEvent.type, account: null,
    tenant: plan.tenant, objectId: plan.objectId, created: eventAt, payload: plan.args
  });
  const { claimed } = await inboxClaim(admin, stripeEvent.id);
  if (!claimed) return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };

  try {
    const { error } = await admin.rpc('stripe_procesar_saas' as never, {
      p_event_id: stripeEvent.id, p_kind: plan.kind, p_args: plan.args
    } as never);
    if (error) throw new Error((error as { message?: string }).message ?? String(error));
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (e) {
    const estado = await inboxFailed(admin, stripeEvent.id, e);
    await reportarErrorServidor('webhook-saas', e, { event: stripeEvent.id, type: stripeEvent.type, estado });
    return { statusCode: 500, body: 'Error de procesamiento' };
  }
};
