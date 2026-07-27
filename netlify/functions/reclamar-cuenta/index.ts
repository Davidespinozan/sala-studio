import ws from 'ws';
// supabase-js arranca Realtime aunque no lo usemos; en Node <22 no hay WebSocket
// global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /reclamar-cuenta — un socio IMPORTADO/invitado activa su login.
 * Body: { email, password, slug }  (slug = subdominio del gym)
 *
 * NO es un signup abierto: solo funciona si ya existe una ficha SIN cuenta
 * (auth_id NULL) con ese email en ese gym. Crea el login y el trigger
 * on_auth_user_created lo vincula a esa ficha (conserva su membresía y status).
 * Si no hay ficha pendiente, se rechaza (no se crean cuentas de la nada).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const { email, password, slug, codigo } = JSON.parse(event.body || '{}') as {
      email?: string; password?: string; slug?: string; codigo?: string;
    };
    const emailLc = String(email ?? '').trim().toLowerCase();
    const codigoUp = String(codigo ?? '').trim().toUpperCase();
    if (!EMAIL_RE.test(emailLc)) return badRequest('Email inválido');
    if (!password || password.length < 8) return badRequest('La contraseña debe tener al menos 8 caracteres');
    if (!slug) return badRequest('Falta el gimnasio');
    if (!codigoUp) return badRequest('Falta el código de activación');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    // 1) Tenant del subdominio.
    const { data: tenant } = await admin
      .from('tenants')
      .select('id, slug')
      .eq('slug', slug)
      .eq('status', 'activo')
      .maybeSingle();
    if (!tenant) return badRequest('No encontramos este gimnasio');

    // 2) Debe existir una ficha pendiente (sin auth) con ese email en el gym.
    const { data: ficha } = await admin
      .from('usuarios')
      .select('id, auth_id, nombre')
      .eq('tenant_id', tenant.id)
      .eq('email', emailLc)
      .maybeSingle();

    if (!ficha) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No encontramos tu cuenta. Habla con el gimnasio para que te den de alta.', code: 'SIN_FICHA' })
      };
    }
    if (ficha.auth_id) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Esa cuenta ya está activa. Inicia sesión con tu contraseña.', code: 'YA_ACTIVA' })
      };
    }

    // 2b) Prueba de identidad: un CÓDIGO válido y vigente que recepción le dio al
    //     socio. Sin esto, conocer el email bastaría para robar la ficha.
    const { data: cod } = await admin
      .from('codigos_activacion')
      .select('codigo, expira_at')
      .eq('usuario_id', ficha.id)
      .maybeSingle();
    if (!cod || String(cod.codigo).toUpperCase() !== codigoUp || new Date(cod.expira_at as string) <= new Date()) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'El código no es válido o venció. Pídele uno nuevo al gimnasio.', code: 'CODIGO_INVALIDO' })
      };
    }

    // 3) Crear el login. El trigger ya NO auto-vincula (seguridad): la ficha se
    //    engancha explícitamente abajo.
    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email: emailLc,
      password,
      email_confirm: true,
      user_metadata: { tenant_slug: tenant.slug, nombre: ficha.nombre ?? undefined }
    });

    if (authErr || !authData?.user) {
      const msg = (authErr?.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        return {
          statusCode: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Ya existe una cuenta con ese email. Inicia sesión.', code: 'YA_ACTIVA' })
        };
      }
      return serverError('No pudimos activar tu cuenta. Intenta de nuevo.');
    }

    // 4) Vincular EXPLÍCITAMENTE la ficha a este login (el trigger ya no lo hace).
    //    El WHERE auth_id IS NULL evita pisar una ficha que se reclamó en paralelo.
    const { data: vinculada } = await admin
      .from('usuarios')
      .update({ auth_id: authData.user.id })
      .eq('id', ficha.id)
      .is('auth_id', null)
      .select('id')
      .maybeSingle();
    if (!vinculada) {
      // No quedó enganchada (carrera, o ya se reclamó): deshacer el login.
      await admin.auth.admin.deleteUser(authData.user.id);
      return serverError('No pudimos vincular tu cuenta. Intenta de nuevo o habla con el gimnasio.');
    }

    // 5) Consumir el código (un solo uso).
    await admin.from('codigos_activacion').delete().eq('usuario_id', ficha.id);

    return ok({ success: true });
  } catch (err) {
    console.error('[reclamar-cuenta]', err instanceof Error ? err.message : err);
    return serverError('No pudimos activar tu cuenta');
  }
};
