import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';

/**
 * POST /stripe-webhook  — ESQUELETO (inerte hasta conectar Stripe).
 *
 * Recibe los eventos de Stripe y materializa la membresía del socio vía el RPC
 * `activar_suscripcion_socio` (la MISMA que usa el mock del demo). Mientras no
 * exista STRIPE_WEBHOOK_SECRET, responde 200 sin hacer nada (no rompe).
 *
 * CONECTAR STRIPE (al final) — completar los 2 [TODO]:
 *   1. Verificar la firma con stripe.webhooks.constructEvent(rawBody, sig, secret).
 *   2. Mapear los eventos a acciones:
 *        - checkout.session.completed / customer.subscription.created|updated
 *            → activar_suscripcion_socio(usuario_id, tier_id,
 *                 stripe_subscription_id, stripe_customer_id, periodo_fin)
 *        - customer.subscription.deleted → marcar la membresía 'cancelada'.
 *      El usuario_id y el tier_id se resuelven del metadata de la session/sub
 *      (que la function de checkout debe setear) o por stripe_customer_id /
 *      stripe_price_id.
 */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  const webhookSecret = optionalEnv('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) {
    // Stripe todavía no conectado → no-op explícito (no falla el deploy).
    return ok({ skipped: 'stripe_no_configurado' });
  }

  try {
    // [TODO STRIPE 1] Verificar firma:
    //   const sig = event.headers['stripe-signature'];
    //   const stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
    //
    // [TODO STRIPE 2] Mapear stripeEvent.type → activar/cancelar vía el RPC.
    //   const admin = createClient(requireEnv('VITE_SUPABASE_URL'),
    //                              requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    //                              { auth: { persistSession: false } });
    //   await admin.rpc('activar_suscripcion_socio', { ... });

    // Placeholder hasta completar lo de arriba.
    void createClient; // evita unused import hasta implementar
    void requireEnv;
    return ok({ received: true });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'webhook error');
  }
};
