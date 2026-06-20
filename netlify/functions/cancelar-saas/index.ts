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
 * POST /cancelar-saas — Flujo 1: cancelar o reactivar la suscripción del gym.
 * Auth: Bearer JWT del ADMIN. Body: { reactivar?: boolean }.
 *
 * Cancelar = cancel_at_period_end:true (mantiene el acceso hasta el fin del
 * periodo, sin reembolso). Reactivar = cancel_at_period_end:false. NO toca la DB:
 * el webhook stripe-webhook-saas sincroniza suscripciones_saas. Devuelve el
 * nuevo cancel_at_period_end para feedback inmediato.
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

    const { data: admin } = await asUser
      .from('usuarios')
      .select('tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!admin?.tenant_id) return forbidden('No encontramos tu cuenta');
    if (admin.rol !== 'admin' || admin.status !== 'activo') {
      return forbidden('Solo el admin del gym puede gestionar la suscripción');
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ ok: false, reason: 'stripe_pendiente' });
    }

    const adminDb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: sus } = await adminDb
      .from('suscripciones_saas')
      .select('stripe_subscription_id')
      .eq('tenant_id', admin.tenant_id)
      .maybeSingle();

    const subId = sus?.stripe_subscription_id ?? null;
    if (!subId || subId.startsWith('mock_')) {
      return ok({ ok: false, reason: 'sin_suscripcion_stripe' });
    }

    const stripe = getStripe();
    await stripe.subscriptions.update(subId, { cancel_at_period_end: !reactivar });

    return ok({ ok: true, cancel_at_period_end: !reactivar });
  } catch (err) {
    console.error('[cancelar-saas]', err instanceof Error ? err.message : err);
    return serverError('No pudimos actualizar la suscripción');
  }
};
