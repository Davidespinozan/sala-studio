import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';

/**
 * POST /cancelar-membresia — Flujo 2: el SOCIO cancela su suscripción (mensualidad).
 * Auth: Bearer JWT del socio. Body: { reactivar?: boolean }.
 *
 * cancel_at_period_end en la suscripción de la cuenta conectada (mantiene el
 * acceso hasta el fin del periodo). El webhook (subscription.deleted) marca la
 * membresía 'cancelada' cuando termina. Los PAQUETES no se cancelan (se agotan).
 */

interface Body {
  reactivar?: boolean;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const reactivar = body.reactivar === true;

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: socio } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return forbidden('Sin perfil');

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ ok: false, reason: 'stripe_pendiente' });
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: tenant } = await admin
      .from('tenants')
      .select('stripe_account_id')
      .eq('id', socio.tenant_id)
      .maybeSingle();
    const acct = tenant?.stripe_account_id ?? null;

    // Suscripción vigente del socio (la membresía activa con sub de Stripe).
    const { data: mem } = await admin
      .from('membresias')
      .select('stripe_subscription_id')
      .eq('usuario_id', socio.id)
      .in('status', ['activa', 'trialing', 'past_due', 'congelada'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const subId = mem?.stripe_subscription_id ?? null;
    if (!acct || !subId || subId.startsWith('mock_')) {
      // Sin suscripción de Stripe → es un paquete (se agota) o el demo.
      return ok({ ok: false, reason: 'sin_suscripcion' });
    }

    const stripe = getStripe();
    await stripe.subscriptions.update(subId, { cancel_at_period_end: !reactivar }, { stripeAccount: acct });

    return ok({ ok: true, cancel_at_period_end: !reactivar });
  } catch (err) {
    console.error('[cancelar-membresia]', err instanceof Error ? err.message : err);
    return serverError('No pudimos actualizar tu suscripción');
  }
};
