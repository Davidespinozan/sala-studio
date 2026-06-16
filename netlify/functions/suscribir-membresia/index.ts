import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22 no hay
// WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /suscribir-membresia
 * Auth: Bearer JWT del SOCIO (puede ser anónimo, en el demo)
 * Body: { tier_id: string }
 *
 * Punto ÚNICO de enchufe de Stripe para la compra de membresía del socio.
 *
 * HOY (sin Stripe):
 *   - Tenant DEMO  → activa la membresía con pago SIMULADO (RPC
 *     activar_suscripcion_socio) → { activated: true }. Así el visitante del
 *     demo compra su plan y ve la experiencia completa.
 *   - Tenant REAL  → no cobra ni activa nada → { activated: false,
 *     reason: 'stripe_pendiente' }. La UI muestra "pago en camino".
 *
 * CONECTAR STRIPE (al final) — reemplazar el bloque marcado [TODO STRIPE]:
 *   1. Crear una Checkout Session de Stripe (mode: 'subscription') con el
 *      stripe_price_id del tier y el customer del socio.
 *   2. Devolver { url } de la session → la UI redirige.
 *   3. La activación real la dispara el webhook (ver stripe-webhook), que llama
 *      a activar_suscripcion_socio con los IDs reales. NO activar acá.
 */

// Tenant cuyo demo permite "comprar" con pago simulado (ver DEMO_TENANT_SLUG en
// el front). En tenants reales, sin Stripe, no se activa nada.
const DEMO_TENANT_SLUG = 'healthyspace';

interface Body {
  tier_id?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.tier_id) return badRequest('Falta tier_id');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // 1) Identificar al socio que pide (con su propio token).
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
    if (!socio) return unauthorized('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un socio puede comprar membresía');

    // 2) Resolver el slug del tenant (para el gate del demo).
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: tenant } = await admin
      .from('tenants')
      .select('slug')
      .eq('id', socio.tenant_id)
      .maybeSingle();
    const esDemo = tenant?.slug === DEMO_TENANT_SLUG;

    // 3) Validar que el tier es de su tenant y está activo.
    const { data: tier } = await admin
      .from('tiers')
      .select('id, activo, tenant_id')
      .eq('id', body.tier_id)
      .maybeSingle();
    if (!tier || tier.tenant_id !== socio.tenant_id || tier.activo !== true) {
      return badRequest('Plan inválido');
    }

    // ── [TODO STRIPE] ────────────────────────────────────────────────────────
    // En tenant real: crear Checkout Session y devolver { url } para redirigir.
    // Hoy, sin Stripe, no se cobra ni activa nada en tenants reales.
    if (!esDemo) {
      return ok({ activated: false, reason: 'stripe_pendiente' });
    }
    // ──────────────────────────────────────────────────────────────────────────

    // DEMO: pago simulado → activar de una vez (misma RPC que usará el webhook).
    const { data: result, error: rpcErr } = await admin.rpc('activar_suscripcion_socio', {
      p_usuario_id: socio.id,
      p_tier_id: body.tier_id
    });
    if (rpcErr) return serverError(rpcErr.message);

    return ok({ activated: true, result });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
