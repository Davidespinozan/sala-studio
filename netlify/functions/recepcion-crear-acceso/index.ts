import ws from 'ws';
// supabase-js arranca Realtime aunque no lo usemos; en Node <22 no hay WebSocket
// global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler, HandlerResponse } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /recepcion-crear-acceso — el STAFF le da acceso a la app a un socio
 * IMPORTADO que aún no tiene login. Auth: Bearer JWT del staff.
 * Body: { usuario_id, email, password }
 *
 * Es la vía SIMPLE (sin código): el socio está en el mostrador, el staff (que ya
 * está autenticado y validado como recepción/admin del gym) lo verifica en
 * persona y le crea el login ahí mismo. Reemplaza el "código de activación" para
 * altas presenciales — el código sigue existiendo para activación remota.
 *
 * Mismo enganche que reclamar-cuenta: se le pone el email real a la ficha, se
 * crea la cuenta auth (con el tenant_slug para que el trigger NO caiga a demo, y
 * su ON CONFLICT (tenant_id,email) evite duplicar la ficha) y se liga auth_id a
 * la ficha existente — conservando su membresía y su historial.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CONFLICT = (error: string, code: string): HandlerResponse => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error, code })
});

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const { usuario_id, email, password } = JSON.parse(event.body || '{}') as {
      usuario_id?: string; email?: string; password?: string;
    };
    const emailLc = String(email ?? '').trim().toLowerCase();
    if (!usuario_id) return badRequest('Falta el socio');
    if (!EMAIL_RE.test(emailLc)) return badRequest('El email no tiene un formato válido');
    if (!password || password.length < 8) return badRequest('La contraseña debe tener al menos 8 caracteres');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // ── Quién llama (staff) ──────────────────────────────────────────────────
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: uErr } = await asUser.auth.getUser();
    if (uErr || !authUser) return unauthorized('Token inválido');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: staff } = await admin
      .from('usuarios')
      .select('tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    // is_recepcionista abarca recepción Y admin; exigimos staff activo del tenant.
    if (!staff || !['recepcionista', 'admin'].includes(staff.rol as string) || staff.status !== 'activo') {
      return forbidden('Solo recepción o admin pueden crear accesos');
    }

    // ── La ficha destino: existe, del mismo gym, y SIN cuenta todavía ────────
    const { data: ficha } = await admin
      .from('usuarios')
      .select('id, tenant_id, auth_id, nombre')
      .eq('id', usuario_id)
      .maybeSingle();
    if (!ficha) return badRequest('Socio no encontrado');
    if (ficha.tenant_id !== staff.tenant_id) return forbidden('Ese socio es de otro gimnasio');
    if (ficha.auth_id) return CONFLICT('Este socio ya tiene su cuenta activa. Que inicie sesión.', 'YA_ACTIVA');

    // Slug del gym: obligatorio para el trigger (sin él cae a demo y DUPLICA ficha).
    const { data: tenant } = await admin
      .from('tenants')
      .select('slug')
      .eq('id', ficha.tenant_id)
      .maybeSingle();
    if (!tenant?.slug) return serverError('No se pudo resolver el gimnasio');

    // El email no puede estar tomado por OTRA ficha del gym.
    const { data: enUso } = await admin
      .from('usuarios')
      .select('id')
      .eq('tenant_id', ficha.tenant_id)
      .eq('email', emailLc)
      .neq('id', ficha.id)
      .maybeSingle();
    if (enUso) return badRequest('Ese email ya lo usa otro socio de tu gym');

    // ── Poner el email real en la ficha ANTES de crear la cuenta ─────────────
    // Así el ON CONFLICT (tenant_id, email) del trigger encuentra ESTA ficha y no
    // inserta una nueva. (Si era "sin correo", acá se le pone el real.)
    await admin.from('usuarios').update({ email: emailLc }).eq('id', ficha.id);

    // ── Crear el login ───────────────────────────────────────────────────────
    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email: emailLc,
      password,
      email_confirm: true,
      user_metadata: { tenant_slug: tenant.slug, nombre: ficha.nombre ?? undefined }
    });
    if (authErr || !authData?.user) {
      const msg = (authErr?.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        return CONFLICT('Ya existe una cuenta con ese email. Que inicie sesión.', 'EMAIL_TOMADO');
      }
      return serverError('No pudimos crear el acceso. Intenta de nuevo.');
    }

    // ── Ligar la ficha existente a ese login (el trigger ya no lo hace) ──────
    const { data: vinculada } = await admin
      .from('usuarios')
      .update({ auth_id: authData.user.id })
      .eq('id', ficha.id)
      .is('auth_id', null)
      .select('id')
      .maybeSingle();
    if (!vinculada) {
      // No enganchó (carrera / ya tenía cuenta): deshacer el login para no dejar basura.
      await admin.auth.admin.deleteUser(authData.user.id);
      return serverError('No pudimos vincular el acceso. Intenta de nuevo.');
    }

    // Un código de activación viejo ya no sirve: se limpia si lo había.
    await admin.from('codigos_activacion').delete().eq('usuario_id', ficha.id);

    // Aviso EN-APP para que cambie la contraseña temporal. Cae en la campana; la
    // app del socio lo usa además para el aviso en pantalla. Se marca como ya
    // "enviada" a push para que cron-push la salte (esto es solo en-app, no push).
    await admin.from('notificaciones').insert({
      tenant_id: ficha.tenant_id,
      usuario_id: ficha.id,
      tipo: 'cambiar_password',
      titulo: 'Cambia tu contraseña',
      mensaje: 'Entraste con una contraseña temporal que te dio el gimnasio. Por tu seguridad, cámbiala ahora por una tuya.',
      push_enviado_at: new Date().toISOString()
    } as never);

    return ok({ success: true, email: emailLc });
  } catch (err) {
    console.error('[recepcion-crear-acceso]', err instanceof Error ? err.message : err);
    return serverError('No pudimos crear el acceso');
  }
};