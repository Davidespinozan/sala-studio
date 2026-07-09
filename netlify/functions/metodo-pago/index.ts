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
 * POST /metodo-pago — Flujo 2: tarjeta guardada del socio + alta de tarjeta.
 * Auth: Bearer JWT del SOCIO. Body: { action?: 'get' | 'setup' }.
 *   · 'get'   → devuelve la tarjeta por defecto del customer (en la cuenta
 *               conectada del gym): { card: { brand, last4, exp_month, exp_year } } | { card: null }.
 *   · 'setup' → crea una Checkout Session mode 'setup' (embebida) para GUARDAR
 *               una tarjeta sin cobrar → { client_secret, account }.
 */

interface Body {
  action?: 'get' | 'setup' | 'historial';
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const action: 'get' | 'setup' | 'historial' =
      body.action === 'setup' || body.action === 'historial' ? body.action : 'get';

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
      .select('id, tenant_id, rol, stripe_customer_id')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return forbidden('Sin perfil');

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ card: null, reason: 'stripe_pendiente' });
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: tenant } = await admin
      .from('tenants')
      .select('stripe_account_id')
      .eq('id', socio.tenant_id)
      .maybeSingle();
    const acct = tenant?.stripe_account_id ?? null;
    const customerId = socio.stripe_customer_id;

    if (!acct) return ok({ card: null });

    const stripe = getStripe();

    // Alta de tarjeta: Checkout Session mode 'setup' (embebida) sobre la cuenta conectada.
    if (action === 'setup') {
      if (!customerId || customerId.startsWith('mock_')) {
        return ok({ client_secret: null, reason: 'sin_customer' });
      }
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'setup',
          ui_mode: 'embedded_page',
          redirect_on_completion: 'never',
          customer: customerId,
          // metadata app:'sala' → el webhook Connect reconoce el guardado de
          // tarjeta y promueve el PM + reintenta la factura vencida (past_due).
          metadata: { app: 'sala', usuario_id: socio.id, tenant_id: socio.tenant_id }
        },
        { stripeAccount: acct }
      );
      return ok({ client_secret: session.client_secret, account: acct });
    }

    // Historial: últimos cobros del socio en la cuenta conectada.
    if (action === 'historial') {
      if (!customerId || customerId.startsWith('mock_')) return ok({ pagos: [] });
      const charges = await stripe.charges.list({ customer: customerId, limit: 12 }, { stripeAccount: acct });
      return ok({
        pagos: charges.data.map((c) => ({
          id: c.id,
          amount: c.amount,
          currency: c.currency,
          created: c.created,
          status: c.status,
          descripcion: c.description ?? null
        }))
      });
    }

    // GET: tarjeta por defecto del customer.
    if (!customerId || customerId.startsWith('mock_')) return ok({ card: null });

    const cust = (await stripe.customers.retrieve(customerId, {}, { stripeAccount: acct })) as any;
    let pm: any = null;
    const defaultPm = cust?.invoice_settings?.default_payment_method;
    if (defaultPm) {
      pm = await stripe.paymentMethods.retrieve(
        typeof defaultPm === 'string' ? defaultPm : defaultPm.id,
        {},
        { stripeAccount: acct }
      );
    } else {
      const list = await stripe.paymentMethods.list(
        { customer: customerId, type: 'card', limit: 1 },
        { stripeAccount: acct }
      );
      pm = list.data[0] ?? null;
    }

    if (pm?.card) {
      return ok({
        card: {
          brand: pm.card.brand,
          last4: pm.card.last4,
          exp_month: pm.card.exp_month,
          exp_year: pm.card.exp_year
        }
      });
    }
    return ok({ card: null });
  } catch (err) {
    console.error('[metodo-pago]', err instanceof Error ? err.message : err);
    return serverError('No pudimos consultar el método de pago');
  }
};
