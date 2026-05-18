import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /fake-signup
 * Body: { nombre, email, password, tier: 'basica' | 'pro' }
 *
 * Crea cuenta de prueba con pago simulado:
 * - auth.admin.createUser (email confirmado automáticamente)
 * - El trigger on_auth_user_created inserta fila en `usuarios`
 * - UPDATE para setear tier, status='activo', tenant=ekko, notas_admin
 * - Log en payment_events con stripe_event_type='fake_signup'
 *
 * Cuando se integre Stripe real, esta función se reemplaza por el webhook
 * de Stripe. El cliente Signup.tsx no cambia.
 */

const TIERS_VALIDOS = ['basica', 'pro'] as const;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[fake-signup] Missing env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    const { nombre, email, password, tier } = JSON.parse(event.body || '{}');

    if (!nombre || !email || !password || !tier) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Faltan datos requeridos' })
      };
    }

    if (!TIERS_VALIDOS.includes(tier)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Tier inválido' })
      };
    }

    // 1. Obtener tenant 'ekko'
    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .select('id')
      .eq('slug', 'ekko')
      .single();

    if (tenantError || !tenant) {
      console.error('[fake-signup] tenant error:', tenantError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Error de configuración' })
      };
    }

    // 1b. Obtener tier real de BD para usar su precio (no hardcode)
    const { data: tierData, error: tierError } = await supabaseAdmin
      .from('tiers')
      .select('precio_centavos')
      .eq('tenant_id', tenant.id)
      .eq('slug', tier)
      .eq('activo', true)
      .single();

    if (tierError || !tierData) {
      console.error('[fake-signup] tier error:', tierError);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Plan "${tier}" no encontrado o inactivo.` })
      };
    }

    // 2. Crear usuario en auth.users — esto dispara el trigger
    //    on_auth_user_created que inserta fila en `usuarios` con
    //    rol='miembro', status='pendiente_onboarding'.
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nombre, tenant_slug: 'ekko' }
    });

    if (authError || !authData.user) {
      console.error('[fake-signup] auth error:', authError);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: authError?.message || 'Error al crear usuario' })
      };
    }

    const authUserId = authData.user.id;

    // 3. Actualizar la fila que creó el trigger con tier + status activo.
    //    NOTA: la columna FK a auth.users se llama `auth_id` (no auth_user_id).
    const fechaHoy = new Date().toLocaleDateString('es-MX');
    const { data: usuarioUpdated, error: updateError } = await supabaseAdmin
      .from('usuarios')
      .update({
        nombre,
        membresia_tier: tier,
        status: 'activo',
        rol: 'miembro',
        tenant_id: tenant.id,
        notas_admin: `CUENTA DE PRUEBA — PAGO FAKE — ${fechaHoy}`
      })
      .eq('auth_id', authUserId)
      .select('id')
      .single();

    if (updateError || !usuarioUpdated) {
      console.error('[fake-signup] update error:', updateError);
      // Best-effort cleanup: borrar auth.user para no dejar zombies
      await supabaseAdmin.auth.admin.deleteUser(authUserId);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Error al activar cuenta' })
      };
    }

    // 4. Registrar evento de pago fake en payment_events.
    //    El schema real es Stripe-céntrico: necesita stripe_event_id único,
    //    stripe_event_type y raw_payload. Usamos prefijos 'fake_' para
    //    distinguir de eventos reales cuando se integre Stripe.
    const fakeEventId = `fake_signup_${authUserId}_${Date.now()}`;
    const montoCentavos = tierData.precio_centavos;

    await supabaseAdmin
      .from('payment_events')
      .insert({
        stripe_event_id: fakeEventId,
        stripe_event_type: 'fake_signup',
        tenant_id: tenant.id,
        usuario_id: usuarioUpdated.id,
        monto_centavos: montoCentavos,
        moneda: 'MXN',
        status: 'fake_succeeded',
        raw_payload: { tier, fake: true, fecha: fechaHoy, source: 'fake-signup function' },
        processed_at: new Date().toISOString()
      });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        auth_user_id: authUserId
      })
    };
  } catch (err) {
    console.error('[fake-signup] unexpected error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err instanceof Error ? err.message : 'Error inesperado'
      })
    };
  }
};
