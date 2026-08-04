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
 * cambiarla al entrar. El alta es 100% en recepción, así que:
 *   - El email YA es socio (tiene ficha sin login) → se activa su cuenta.
 *   - El email NO tiene ficha → se RECHAZA (que pase a recepción). NO creamos
 *     ficha por auto-servicio: si el socio teclea un email distinto al que
 *     registró recepción, crearíamos una ficha huérfana duplicada.
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
      // La cuenta ya existe. Caso típico de socios creados por el flujo viejo (que
      // creaba el login con Cambiar123 al dar de alta): tienen cuenta pero NUNCA
      // la usaron, y como /activar decía "ya activa" nunca veían su clave temporal
      // → quedaban atorados y solo el reset los metía. Ahora: si NUNCA iniciaron
      // sesión, les reafirmamos y RE-MOSTRAMOS la temporal (Cambiar123, que es
      // pública: no expone nada). Si ya entraron alguna vez, NO tocamos su clave.
      const { data: authInfo } = await admin.auth.admin.getUserById(fichaPrevia.auth_id);
      const nuncaInicioSesion = !authInfo?.user?.last_sign_in_at;
      if (!nuncaInicioSesion) {
        return CONFLICT('Esa cuenta ya está activa. Inicia sesión con tu contraseña.', 'YA_ACTIVA');
      }
      await admin.auth.admin.updateUserById(fichaPrevia.auth_id, {
        password: PASSWORD_TEMPORAL,
        email_confirm: true
      });
      // Aviso en-app para forzar el cambio (idempotente: si ya había uno sin leer,
      // no pasa nada por tener otro).
      await admin.from('notificaciones').insert({
        tenant_id: tenant.id,
        usuario_id: fichaPrevia.id,
        tipo: 'cambiar_password',
        titulo: 'Cambia tu contraseña',
        mensaje: 'Entraste con una contraseña temporal. Por tu seguridad, cámbiala ahora por una tuya.',
        push_enviado_at: new Date().toISOString()
      } as never);
      return ok({ success: true, nueva: false });
    }
    // Alta 100% en recepción: si el email no tiene ficha, NO lo creamos por
    // auto-servicio (evita fichas huérfanas cuando el socio teclea un email
    // distinto al que registró recepción). Se le pide pasar a recepción.
    if (!fichaPrevia) {
      return CONFLICT(
        'No reconocimos este correo. Verifica que sea el que registraste en el gimnasio, o pídele a recepción que te dé de alta.',
        'NO_FICHA'
      );
    }

    // 3) Crear el login. El trigger handle_new_auth_user hace ON CONFLICT
    //    (tenant_id,email) DO NOTHING porque la ficha del socio ya existe.
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
    // El trigger hizo DO NOTHING (la ficha ya existía) → ligamos el login acá.
    if (!ficha.auth_id) {
      await admin.from('usuarios').update({ auth_id: authData.user.id }).eq('id', ficha.id).is('auth_id', null);
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

    return ok({ success: true, nueva: false });
  } catch (err) {
    console.error('[activar-cuenta]', err instanceof Error ? err.message : err);
    return serverError('No pudimos activar tu cuenta');
  }
};