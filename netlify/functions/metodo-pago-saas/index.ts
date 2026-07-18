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
 * POST /metodo-pago-saas — la tarjeta con la que el GYM le paga a SALA.
 * Auth: Bearer JWT del ADMIN. Devuelve { card: { brand, last4, exp_month, exp_year } | null }.
 *
 * OJO: esto es la cuenta PLATAFORMA de SALA (el gym pagándonos a nosotros), NO
 * la cuenta conectada — por eso acá NO va `stripeAccount` en las opciones, a
 * diferencia de metodo-pago (que es el socio pagándole al gym).
 *
 * POR QUÉ EXISTE: la pantalla de Suscripción decía "Prueba gratis" sin mostrar
 * jamás si había una tarjeta registrada. Un gym que nunca completó el checkout
 * veía exactamente lo mismo que uno que sí pagó, y se enteraba de que no tenía
 * tarjeta el día que el paywall lo cortaba.
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
      return forbidden('Solo el admin del gym puede ver la facturación');
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ card: null, reason: 'stripe_pendiente' });
    }

    const adminDb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: sus } = await adminDb
      .from('suscripciones_saas')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('tenant_id', admin.tenant_id)
      .maybeSingle();

    const customerId = (sus?.stripe_customer_id as string | null) ?? null;
    const subId = (sus?.stripe_subscription_id as string | null) ?? null;

    // Sin customer, o con los placeholders 'mock_*' del checkout viejo → nunca
    // hubo tarjeta de verdad.
    if (!customerId || customerId.startsWith('mock_')) return ok({ card: null });

    const stripe = getStripe();

    // La tarjeta que Stripe usará para cobrar: primero la de la suscripción,
    // después la default del customer, y si no hay ninguna, la primera listada.
    let pmId: string | null = null;

    if (subId && !subId.startsWith('mock_')) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        const dpm = (sub as any)?.default_payment_method;
        if (dpm) pmId = typeof dpm === 'string' ? dpm : dpm.id;
      } catch (e) {
        console.error('[metodo-pago-saas] sub', e instanceof Error ? e.message : e);
      }
    }

    if (!pmId) {
      const cust = (await stripe.customers.retrieve(customerId)) as any;
      const dpm = cust?.invoice_settings?.default_payment_method;
      if (dpm) pmId = typeof dpm === 'string' ? dpm : dpm.id;
    }

    let pm: any = null;
    if (pmId) {
      pm = await stripe.paymentMethods.retrieve(pmId);
    } else {
      const list = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      pm = list.data[0] ?? null;
    }

    if (!pm?.card) return ok({ card: null });

    return ok({
      card: {
        brand: pm.card.brand ?? null,
        last4: pm.card.last4 ?? null,
        exp_month: pm.card.exp_month ?? null,
        exp_year: pm.card.exp_year ?? null
      }
    });
  } catch (err) {
    console.error('[metodo-pago-saas]', err instanceof Error ? err.message : err);
    return serverError('No pudimos consultar tu medio de pago');
  }
};