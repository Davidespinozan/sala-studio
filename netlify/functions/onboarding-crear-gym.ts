import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from './_lib/http';
import { requireEnv } from './_lib/env';

// ════════════════════════════════════════════════════════════════════════════
// POST /onboarding-crear-gym
// ════════════════════════════════════════════════════════════════════════════
// Crea un gym (tenant) completo, self-service:
//   1. Crea el auth user (auth.admin.createUser, email_confirm: true → sin mail).
//      Pasa onboarding='true' en metadata → el trigger on_auth_user_created
//      NO crea fila usuarios (lo hace el RPC con rol admin).
//   2. Llama al RPC crear_tenant_onboarding() — crea atómicamente tenant +
//      usuario admin + suscripción trial + tiers base + primera sala.
//   3. Si el RPC falla → borra el auth user (compensating action) para no
//      dejar una cuenta huérfana.
//
// MOCK: el "pago" es simulado — el RPC crea la suscripción con estado 'trial'
// e ids 'mock_*'. Para Stripe real, el cobro iría antes (Checkout) y la
// suscripción la crearía el webhook; esta función y el wizard no cambian.
// ════════════════════════════════════════════════════════════════════════════

// Empieza y termina en alfanumérico; guiones solo en el medio.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const RESERVADOS = new Set([
  'admin', 'www', 'app', 'api', 'sala', 'sala-demo', 'registro', 'onboarding',
  'login', 'signup', 'dashboard', 'recepcion', 'public', 'cuenta', 'billing',
  'support', 'status', 'mail', 'dev', 'staging', 'test', 'demo'
]);
const TIERS = new Set(['starter', 'pro', 'business']);
const MONEDAS = new Set(['mxn', 'usd', 'eur']);

interface Body {
  nombre: string;
  email: string;
  password: string;
  gymNombre: string;
  slug: string;
  timezone: string;
  tier: string;
  moneda: string;
  precioCentavos: number;
  colorPrimario: string;
  colorAcento?: string;
  logoUrl: string | null;
  salaNombre: string;
  salaCupo: number;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    let b: Body;
    try {
      b = JSON.parse(event.body || '{}');
    } catch {
      return badRequest('JSON inválido');
    }

    // ── Validación de borde (defensa; el cliente ya valida con onboardingLogic) ──
    if (!b.nombre?.trim() || !b.email?.includes('@') || !b.password || b.password.length < 8) {
      return badRequest('Datos de cuenta incompletos o inválidos.');
    }
    if (!b.gymNombre?.trim()) return badRequest('Falta el nombre del gym.');

    const slug = (b.slug || '').trim().toLowerCase();
    if (
      slug.length < 3 ||
      slug.length > 30 ||
      !SLUG_RE.test(slug) ||
      slug.includes('--') ||
      RESERVADOS.has(slug)
    ) {
      return badRequest('El subdominio no es válido o está reservado.');
    }
    if (!b.timezone) return badRequest('Falta la zona horaria.');
    if (!TIERS.has(b.tier)) return badRequest('Plan inválido.');
    if (!MONEDAS.has(b.moneda)) return badRequest('Moneda inválida.');
    if (!Number.isInteger(b.precioCentavos) || b.precioCentavos < 0) {
      return badRequest('Precio inválido.');
    }
    if (!b.salaNombre?.trim()) return badRequest('Falta el nombre de la sala.');
    if (!Number.isInteger(b.salaCupo) || b.salaCupo < 1) {
      return badRequest('El cupo de la sala debe ser mayor a 0.');
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Pre-chequeo de slug (UX/feedback rápido; el constraint UNIQUE de la BD
    // es el guard real ante una carrera).
    const { data: existente } = await admin
      .from('tenants')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (existente) return badRequest('Ese subdominio ya está en uso. Elegí otro.');

    // ── 1. Crear el auth user ──
    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email: b.email.trim().toLowerCase(),
      password: b.password,
      email_confirm: true,
      user_metadata: { nombre: b.nombre.trim(), onboarding: 'true' }
    });

    if (authErr || !authData?.user) {
      const m = (authErr?.message || '').toLowerCase();
      if (m.includes('already') || m.includes('registered') || m.includes('exists')) {
        return badRequest('Ya existe una cuenta con ese email.');
      }
      return serverError(authErr?.message || 'No se pudo crear la cuenta.');
    }
    const authUserId = authData.user.id;

    // ── 2. RPC atómico: crea tenant + usuario admin + suscripción + tiers + sala ──
    const { data: rpcData, error: rpcErr } = await admin.rpc('crear_tenant_onboarding', {
      p_auth_id: authUserId,
      p_admin_nombre: b.nombre.trim(),
      p_admin_email: b.email.trim().toLowerCase(),
      p_gym_nombre: b.gymNombre.trim(),
      p_slug: slug,
      p_timezone: b.timezone,
      p_tier_saas: b.tier,
      p_moneda: b.moneda,
      p_precio_centavos: b.precioCentavos,
      p_color_primario: b.colorPrimario || '#3d6b52',
      p_color_acento: b.colorAcento || null,
      p_logo_url: b.logoUrl || null,
      p_sala_nombre: b.salaNombre.trim(),
      p_sala_cupo: b.salaCupo
    });

    if (rpcErr) {
      // Compensating action: el tenant no se creó (rollback de la transacción)
      // → borrar el auth user para no dejar una cuenta huérfana.
      await admin.auth.admin.deleteUser(authUserId);
      const msg = rpcErr.message || '';
      if (msg.includes('SLUG_TOMADO')) {
        return badRequest('Ese subdominio ya está en uso. Elegí otro.');
      }
      console.error('[onboarding-crear-gym] RPC error:', rpcErr);
      return serverError('No se pudo crear el gym. Intentá de nuevo.');
    }

    return ok({ success: true, slug, tenant: rpcData });
  } catch (e) {
    console.error('[onboarding-crear-gym]', e);
    return serverError(e instanceof Error ? e.message : 'Error inesperado.');
  }
};
