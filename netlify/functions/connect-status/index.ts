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

    // ── Datos enriquecidos: el dueño quiere VER sus cobros, no solo un
    //    "activo/inactivo". Cada bloque va en su propio try: si Stripe rechaza
    //    uno (permisos, cuenta a medio verificar), el resto del estado igual se
    //    devuelve y la página no se cae por un dato de adorno.
    const businessName =
      account.business_profile?.name ||
      (account.settings?.dashboard?.display_name ?? null);

    // Cuenta bancaria de depósito (la default, si hay).
    let bank: { bank_name: string | null; last4: string | null } | null = null;
    try {
      const banks = await stripe.accounts.listExternalAccounts(accountId, {
        object: 'bank_account',
        limit: 1
      });
      const b = banks.data[0] as { bank_name?: string | null; last4?: string | null } | undefined;
      if (b) bank = { bank_name: b.bank_name ?? null, last4: b.last4 ?? null };
    } catch (e) {
      console.error('[connect-status] bank', e instanceof Error ? e.message : e);
    }

    // Balance de la cuenta CONECTADA (el dinero es del gym, no de SALA).
    let balance: { disponible_centavos: number; pendiente_centavos: number; moneda: string } | null = null;
    try {
      // OJO: la cuenta va en las OPCIONES (2º arg), no en los params. Metida en
      // el 1º, Stripe la ignora y devuelve el balance de la PLATAFORMA — le
      // mostraríamos al gym plata que no es suya.
      const bal = await stripe.balance.retrieve({}, { stripeAccount: accountId });
      const disp = bal.available?.[0];
      const pend = bal.pending?.[0];
      balance = {
        disponible_centavos: disp?.amount ?? 0,
        pendiente_centavos: pend?.amount ?? 0,
        moneda: (disp?.currency ?? pend?.currency ?? account.default_currency ?? 'mxn').toUpperCase()
      };
    } catch (e) {
      console.error('[connect-status] balance', e instanceof Error ? e.message : e);
    }

    // Cómo abre el gym su panel de Stripe (ve cobros, depósitos, disputas). Las
    // cuentas Standard tienen su propio dashboard completo → link normal. Solo las
    // Express usan login link de un solo uso (createLoginLink FALLA en Standard).
    let dashboard_url: string | null = null;
    if (account.type === 'express') {
      try {
        const link = await stripe.accounts.createLoginLink(accountId);
        dashboard_url = link.url ?? null;
      } catch (e) {
        console.error('[connect-status] loginLink', e instanceof Error ? e.message : e);
      }
    } else {
      dashboard_url = 'https://dashboard.stripe.com/';
    }

    return ok({
      connected: true,
      charges_enabled: chargesEnabled,
      details_submitted: detailsSubmitted,
      payouts_enabled: account.payouts_enabled === true,
      account_id: accountId,
      business_name: businessName,
      email: account.email ?? null,
      pais: account.country ?? null,
      payout_interval: account.settings?.payouts?.schedule?.interval ?? null,
      bank,
      balance,
      dashboard_url
    });
  } catch (err) {
    console.error('[connect-status]', err instanceof Error ? err.message : err);
    return serverError('No pudimos consultar el estado de cobros');
  }
};
