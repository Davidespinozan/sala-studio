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
 * POST /connect-status — Flujo 2: estado de la cuenta conectada del gym.
 * Auth: Bearer JWT del ADMIN. Lee la cuenta desde Stripe (autoritativo),
 * persiste charges_enabled/details_submitted en tenants y los devuelve. El front
 * lo llama al entrar a "Cobros" y al volver del onboarding (?connect=done).
 */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

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
      return forbidden('Solo el admin del gym puede ver los cobros');
    }

    const base = { connected: false, charges_enabled: false, details_submitted: false, payouts_enabled: false };

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ ...base, reason: 'stripe_pendiente' });
    }

    const adminDb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: tenant } = await adminDb
      .from('tenants')
      .select('stripe_account_id')
      .eq('id', admin.tenant_id)
      .maybeSingle();

    const accountId = tenant?.stripe_account_id ?? null;
    if (!accountId) return ok(base);

    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(accountId);

    const chargesEnabled = account.charges_enabled === true;
    const detailsSubmitted = account.details_submitted === true;

    await adminDb
      .from('tenants')
      .update({ stripe_charges_enabled: chargesEnabled, stripe_details_submitted: detailsSubmitted })
      .eq('id', admin.tenant_id);

    return ok({
      connected: true,
      charges_enabled: chargesEnabled,
      details_submitted: detailsSubmitted,
      payouts_enabled: account.payouts_enabled === true
    });
  } catch (err) {
    console.error('[connect-status]', err instanceof Error ? err.message : err);
    return serverError('No pudimos consultar el estado de cobros');
  }
};
