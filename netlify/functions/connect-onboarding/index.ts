import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';

/**
 * POST /connect-onboarding — Flujo 2: el gym activa cobros (Stripe Connect Express).
 * Auth: Bearer JWT del ADMIN. Body: { country?: 'MX'|'US'|...; return_path?: string }.
 *
 * Get-or-create de la cuenta conectada (Express) del tenant + Account Link de
 * onboarding hospedado por Stripe. Devuelve { url } para redirigir. El estado
 * (charges_enabled) lo refresca connect-status / el webhook de Connect.
 */

interface Body {
  country?: string;
  return_path?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const country = (body.country || 'MX').toUpperCase();

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
      return forbidden('Solo el admin del gym puede activar los cobros');
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ url: null, reason: 'stripe_pendiente' });
    }

    const stripe = getStripe();
    const adminDb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Get-or-create de la cuenta conectada del tenant.
    const { data: tenant } = await adminDb
      .from('tenants')
      .select('stripe_account_id')
      .eq('id', admin.tenant_id)
      .maybeSingle();

    let accountId = tenant?.stripe_account_id ?? null;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country,
        email: authUser.email ?? undefined,
        metadata: { app: 'sala', tenant_id: admin.tenant_id },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });
      accountId = account.id;
      await adminDb.from('tenants').update({ stripe_account_id: accountId }).eq('id', admin.tenant_id);
    }

    // Link de onboarding hospedado por Stripe (con la marca de SALA).
    const origin =
      event.headers.origin ||
      event.headers.referer?.replace(/\/+$/, '') ||
      optionalEnv('APP_URL', 'https://salastudio.app');
    const returnPath = body.return_path && body.return_path.startsWith('/') ? body.return_path : '/admin/cobros';

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}${returnPath}?connect=refresh`,
      return_url: `${origin}${returnPath}?connect=done`,
      type: 'account_onboarding'
    });

    return ok({ url: link.url });
  } catch (err) {
    console.error('[connect-onboarding]', err instanceof Error ? err.message : err);
    return serverError('No pudimos iniciar la activación de cobros');
  }
};
