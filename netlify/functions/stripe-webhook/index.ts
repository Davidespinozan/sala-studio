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
        if (session.mode !== 'subscription') break;
        const usuarioId = session.metadata?.usuario_id;
        const tierId = session.metadata?.tier_id;
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        if (!usuarioId || !tierId || !subId) break;

        // Periodo: traer la suscripción de la cuenta conectada.
        let periodoFin: string | null = null;
        if (acct) {
          const sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: acct });
          periodoFin = periodEndISO(sub);
        }

        const { error } = await admin.rpc('activar_suscripcion_socio', {
          p_usuario_id: usuarioId,
          p_tier_id: tierId,
          p_stripe_subscription_id: subId,
          p_stripe_customer_id: customerId ?? null,
          p_periodo_fin: periodoFin
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
