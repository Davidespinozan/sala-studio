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
 * POST /portal-saas — Flujo 1: portal de facturación del gym (suscripción a SALA).
 * Auth: Bearer JWT del ADMIN. Abre el Stripe Customer Portal (en la cuenta de la
 * plataforma, NO Connect) para gestionar tarjeta / ver facturas / cancelar.
 * Devuelve { url } para redirigir.
 */

interface Body {
  return_path?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');

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
      return forbidden('Solo el admin del gym puede gestionar la facturación');
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ url: null, reason: 'stripe_pendiente' });
    }

    const adminDb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: sus } = await adminDb
      .from('suscripciones_saas')
      .select('stripe_customer_id')
      .eq('tenant_id', admin.tenant_id)
      .maybeSingle();

    const customerId = sus?.stripe_customer_id ?? null;
    if (!customerId || customerId.startsWith('mock_')) {
      return ok({ url: null, reason: 'sin_suscripcion' });
    }

    const origin =
      event.headers.origin ||
      event.headers.referer?.replace(/\/+$/, '') ||
      optionalEnv('APP_URL', 'https://salastudio.app');
    const returnPath = body.return_path && body.return_path.startsWith('/') ? body.return_path : '/admin/suscripcion';

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}${returnPath}`
    });

    return ok({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[portal-saas]', msg);
    // El portal requiere configurarse una vez en el Dashboard (Settings → Billing
    // → Customer portal). Si falta, avisamos claro en vez de un 500 genérico.
    if (/portal|configuration/i.test(msg)) {
      return ok({ url: null, reason: 'portal_no_configurado' });
    }
    return serverError('No pudimos abrir la facturación');
  }
};
