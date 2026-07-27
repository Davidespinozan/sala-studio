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
    const { email, password, slug } = JSON.parse(event.body || '{}') as {
      email?: string; password?: string; slug?: string;
    };
    const emailLc = String(email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(emailLc)) return badRequest('Email inválido');
    if (!password || password.length < 8) return badRequest('La contraseña debe tener al menos 8 caracteres');
    if (!slug) return badRequest('Falta el gimnasio');

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

    // 3) Crear el login → el trigger engancha el auth_id a la ficha existente
    //    (conserva nombre/status/membresía).
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

    // 4) Verificar que el trigger vinculó (defensa: si por algo no quedó
    //    enganchada, deshacemos el login para no dejar un huérfano).
    const { data: verif } = await admin
      .from('usuarios')
      .select('id')
      .eq('id', ficha.id)
      .eq('auth_id', authData.user.id)
      .maybeSingle();
    if (!verif) {
      await admin.auth.admin.deleteUser(authData.user.id);
      return serverError('No pudimos vincular tu cuenta. Intenta de nuevo o habla con el gimnasio.');
    }

    return ok({ success: true });
  } catch (err) {
    console.error('[reclamar-cuenta]', err instanceof Error ? err.message : err);
    return serverError('No pudimos activar tu cuenta');
  }
};
