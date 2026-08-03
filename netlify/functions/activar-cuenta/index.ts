import ws from 'ws';
// supabase-js arranca Realtime aunque no lo usemos; en Node <22 no hay WebSocket
// global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler, HandlerResponse } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /activar-cuenta — autoservicio web para entrar a la app.
 * Body: { email, slug }
 *
 * Contraseña temporal FIJA (Cambiar123, pública a propósito); la app obliga a
 * cambiarla al entrar. Dos casos:
 *   - El email YA es socio (tiene ficha sin login) → se activa su cuenta.
 *   - El email es NUEVO → se crea una cuenta en estado PENDIENTE DE PAGO: puede
 *     entrar pero no reservar hasta que pague en recepción (le asignen plan).
 *
 * SEGURIDAD (decisión del owner): es abierto por email a propósito — el acceso
 * físico real es huella + recepción, y la clave se cambia de una. No hay código.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_TEMPORAL = 'Cambiar123'; // = src/shared/lib/acceso.ts (público a propósito)

const CONFLICT = (error: string, code: string): HandlerResponse => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error, code })
});

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const { email, slug } = JSON.parse(event.body || '{}') as { email?: string; slug?: string };
    const emailLc = String(email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(emailLc)) return badRequest('El email no tiene un formato válido');
    if (!slug) return badRequest('Falta el gimnasio');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    // 1) El gym del subdominio.
    const { data: tenant } = await admin
      .from('tenants')
      .select('id, slug')
      .eq('slug', slug)
      .eq('status', 'activo')
      .maybeSingle();
    if (!tenant) return badRequest('No encontramos este gimnasio');

    // 2) ¿Ya hay ficha con ese email en el gym?
    const { data: fichaPrevia } = await admin
      .from('usuarios')
      .select('id, auth_id')
      .eq('tenant_id', tenant.id)
      .eq('email', emailLc)
      .maybeSingle();
    if (fichaPrevia?.auth_id) {
      return CONFLICT('Esa cuenta ya está activa. Inicia sesión con tu contraseña.', 'YA_ACTIVA');
    }
    const esNuevo = !fichaPrevia;

    // 3) Crear el login. El trigger handle_new_auth_user, con el tenant_slug:
    //    - si YA existe la ficha (socio) → ON CONFLICT (tenant_id,email) DO NOTHING.
    //    - si es NUEVO → crea la ficha (rol miembro) en ese gym.
    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email: emailLc,
      password: PASSWORD_TEMPORAL,
      email_confirm: true,
      user_metadata: { tenant_slug: tenant.slug }
    });
    if (authErr || !authData?.user) {
      const msg = (authErr?.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        return CONFLICT('Ya existe una cuenta con ese email. Inicia sesión.', 'YA_ACTIVA');
      }
      return serverError('No pudimos activar tu cuenta. Intenta de nuevo.');
    }

    // 4) Asegurar la ficha y el enganche.
    const { data: ficha } = await admin
      .from('usuarios')
      .select('id, auth_id')
      .eq('tenant_id', tenant.id)
      .eq('email', emailLc)
      .maybeSingle();
    if (!ficha) {
      await admin.auth.admin.deleteUser(authData.user.id);
      return serverError('No pudimos crear tu cuenta. Habla con el gimnasio.');
    }
    // Socio existente: el trigger hizo DO NOTHING → se liga acá. Nuevo: el trigger
    // ya la creó con este auth_id (el update no toca nada por el `is null`).
    if (!ficha.auth_id) {
      await admin.from('usuarios').update({ auth_id: authData.user.id }).eq('id', ficha.id).is('auth_id', null);
    }
    // Persona NUEVA → pendiente de pago (no reserva hasta pagar en recepción).
    if (esNuevo) {
      await admin.from('usuarios').update({ status: 'pendiente_pago' }).eq('id', ficha.id);
    }

    // 5) Aviso EN-APP para que cambie la contraseña temporal (solo en-app, no push).
    await admin.from('notificaciones').insert({
      tenant_id: tenant.id,
      usuario_id: ficha.id,
      tipo: 'cambiar_password',
      titulo: 'Cambia tu contraseña',
      mensaje: 'Entraste con una contraseña temporal. Por tu seguridad, cámbiala ahora por una tuya.',
      push_enviado_at: new Date().toISOString()
    } as never);

    return ok({ success: true, nueva: esNuevo });
  } catch (err) {
    console.error('[activar-cuenta]', err instanceof Error ? err.message : err);
    return serverError('No pudimos activar tu cuenta');
  }
};