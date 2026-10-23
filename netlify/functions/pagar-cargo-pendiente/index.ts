import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22 no hay
// WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { getOrCreateSocioCustomer } from '../_lib/connectBilling';

/**
 * POST /pagar-cargo-pendiente
 * Auth: Bearer JWT del SOCIO. Body: {} (opcional { cargo_ids: string[] }).
 *
 * "Pagar con tarjeta" lo que el socio dejó "por cobrar" (plan elegido con
 * "Pagar en recepción", inscripción). Crea una Checkout Session de pago único
 * sobre la cuenta conectada del gym con un ítem por cargo y devuelve { url }.
 * El webhook (checkout.session.completed, metadata.tipo='cargo_pendiente')
 * asienta los pagos y marca los cargos cobrados vía stripe_cobrar_cargos_pendientes;
 * si recepción ya cobró alguno mientras tanto, el webhook reembolsa esa parte.
 * Acá NO se marca nada como pagado.
 */
interface Body {
  cargo_ids?: string[];
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
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    // Solo columnas GRANTeadas a authenticated (ver suscribir-membresia).
    const { data: socio, error: socioErr } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (socioErr) console.error('[pagar-cargo-pendiente] socio:', socioErr.message);
    if (!socio) return unauthorized('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un socio puede pagar sus pendientes');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: privados } = await admin
      .from('usuarios')
      .select('stripe_customer_id')
      .eq('id', socio.id)
      .maybeSingle();
    const stripeCustomerId = (privados?.stripe_customer_id as string | null) ?? null;

    const { data: tenant } = await admin
      .from('tenants')
      .select('id, slug, stripe_account_id, stripe_charges_enabled')
      .eq('id', socio.tenant_id)
      .maybeSingle();

    // Cargos pendientes del socio (service_role: la tabla solo la lee recepción).
    let q = admin
      .from('cargos_pendientes')
      .select('id, concepto, descripcion, monto_centavos, moneda')
      .eq('usuario_id', socio.id)
      .eq('tenant_id', socio.tenant_id)
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: true });
    if (Array.isArray(body.cargo_ids) && body.cargo_ids.length > 0) q = q.in('id', body.cargo_ids);
    const { data: cargos, error: cargosErr } = await q;
    if (cargosErr) return serverError(cargosErr.message);
    if (!cargos || cargos.length === 0) return ok({ reason: 'sin_cargos', total_centavos: 0 });

    const total = cargos.reduce((s, c) => s + (Number(c.monto_centavos) || 0), 0);
    if (total <= 0) return ok({ reason: 'sin_cargos', total_centavos: 0 });

    if (!process.env.STRIPE_SECRET_KEY) return ok({ reason: 'stripe_pendiente', total_centavos: total });
    if (!tenant?.stripe_account_id || tenant.stripe_charges_enabled !== true) {
      return ok({ reason: 'cobros_no_activos', total_centavos: total });
    }

    const stripe = getStripe();
    const acct = tenant.stripe_account_id as string;
    const customerId = await getOrCreateSocioCustomer(
      stripe,
      admin,
      { id: socio.id, email: authUser.email ?? null, stripe_customer_id: stripeCustomerId },
      acct
    );

    const feePct = Number(optionalEnv('SALA_SOCIO_FEE_PERCENT', '0')) || 0;
    const origin =
      event.headers.origin ||
      event.headers.referer?.replace(/\/+$/, '') ||
      optionalEnv('APP_URL', 'https://salastudio.app');
    const currency = String(cargos[0].moneda || 'mxn').toLowerCase();
    const cargoIds = cargos.map((c) => c.id as string);

    // El webhook lee esto para asentar el pago contra ESTOS cargos.
    const meta = {
      app: 'sala',
      tipo: 'cargo_pendiente',
      usuario_id: socio.id,
      tenant_id: socio.tenant_id,
      cargo_ids: cargoIds.join(',')
    };

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer: customerId,
        line_items: cargos.map((c) => ({
          price_data: {
            currency,
            product_data: { name: (c.descripcion as string | null) || `Pago pendiente · ${c.concepto}` },
            unit_amount: Number(c.monto_centavos)
          },
          quantity: 1
        })),
        payment_intent_data: {
          metadata: meta,
          ...(feePct > 0 ? { application_fee_amount: Math.round((total * feePct) / 100) } : {})
        },
        metadata: meta,
        success_url: `${origin}/app?cargo=ok`,
        cancel_url: `${origin}/app?cargo=cancel`
      },
      { stripeAccount: acct }
    );
    return ok({ url: session.url, total_centavos: total });
  } catch (err) {
    console.error('[pagar-cargo-pendiente]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
