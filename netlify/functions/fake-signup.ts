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
 * Body: { nombre, email, password, tier, slug }  (slug = subdominio del gym)
 *
 * Crea cuenta de prueba con pago simulado, EN EL TENANT DEL SUBDOMINIO (slug):
 * - auth.admin.createUser (email confirmado automáticamente)
 * - El trigger on_auth_user_created inserta fila en `usuarios`
 * - UPDATE para setear tier, status='activo', tenant=<el del slug>, notas_admin
 * - Log en payment_events
 *
 * Cuando se integre Stripe real, esta función se reemplaza por el webhook
 * de Stripe. El cliente Signup.tsx no cambia.
 */

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
    const { nombre, email, password, tier, slug, sucursal_id } = JSON.parse(event.body || '{}');

    if (!nombre || !email || !password || !tier || !slug) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Faltan datos requeridos' })
      };
    }

    // 1. Obtener el tenant DEL SUBDOMINIO (slug), activo. El socio se da de alta
    //    en el gimnasio cuyo subdominio está visitando — no en sala-demo.
    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .select('id, slug')
      .eq('slug', slug)
      .eq('status', 'activo')
      .single();

    if (tenantError || !tenant) {
      console.error('[fake-signup] tenant error:', tenantError, { slug });
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No encontramos este gimnasio. Revisá el enlace.' })
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

    // 1c. Resolver la sede del socio. Si el gym es multisede, el signup manda la
    //     elegida; validamos que sea de este tenant. Si no manda ninguna (gym de
    //     1 sede o cliente viejo), caemos a la sede por defecto (menor orden).
    let sucursalId: string | null = null;
    if (sucursal_id) {
      const { data: suc } = await supabaseAdmin
        .from('sucursales')
        .select('id')
        .eq('id', sucursal_id)
        .eq('tenant_id', tenant.id)
        .eq('activa', true)
        .maybeSingle();
      sucursalId = suc?.id ?? null;
    }
    if (!sucursalId) {
      const { data: defSuc } = await supabaseAdmin
        .from('sucursales')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('activa', true)
        .order('orden', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      sucursalId = defSuc?.id ?? null;
    }

    // 2. Crear usuario en auth.users — esto dispara el trigger
    //    on_auth_user_created que inserta fila en `usuarios` con
    //    rol='miembro', status='pendiente_onboarding'.
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nombre, tenant_slug: tenant.slug }
    });

    if (authError || !authData.user) {
      console.error('[fake-signup] auth error:', authError);
      const msg = (authError?.message || '').toLowerCase();
      const yaExiste = msg.includes('already') || msg.includes('registered') || msg.includes('exists');
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: yaExiste
            ? 'Ya existe una cuenta con ese email. Iniciá sesión.'
            : 'No pudimos crear la cuenta. Intentá de nuevo.',
          code: yaExiste ? 'EMAIL_EXISTE' : 'CREATE_FAILED'
        })
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
        sucursal_id: sucursalId,
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
