import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /reception-reset-password — Recepción/admin deja al socio con una clave
 * TEMPORAL fija (Cambiar123) para que entre. Auth: Bearer JWT del staff.
 * Body: { usuario_id }. Gate: caller recepcionista/admin activo + mismo tenant;
 * target rol 'miembro'. Devuelve { password }. Queda en la bitácora.
 *
 * "Resetear" SIEMPRE debe dejar un login que funcione con Cambiar123:
 *   - Si el socio YA tiene cuenta → resetea la clave Y sincroniza el email de la
 *     cuenta con el de la ficha (si no coincidían, por eso no entraba).
 *   - Si NO tiene cuenta (ficha sin login) → la CREA (como "dar acceso") y la liga.
 */

interface Body { usuario_id?: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Contraseña temporal fija = src/shared/lib/acceso.ts (pública a propósito; la app
// obliga a cambiarla al entrar).
const PASSWORD_TEMPORAL = 'Cambiar123';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('Falta usuario_id');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // 1) Identificar al staff que pide + validar rol/estado.
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: staff } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol, nombre, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!staff || staff.status !== 'activo' || (staff.rol !== 'recepcionista' && staff.rol !== 'admin')) {
      return forbidden('Solo recepción o admin pueden resetear contraseñas');
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // 2) Target: socio del MISMO tenant.
    const { data: socio } = await admin
      .from('usuarios')
      .select('id, tenant_id, rol, nombre, email, auth_id')
      .eq('id', body.usuario_id)
      .maybeSingle();
    if (!socio) return badRequest('Socio no encontrado');
    if (socio.tenant_id !== staff.tenant_id) return forbidden('Ese socio no pertenece a tu negocio');
    if (socio.rol !== 'miembro') return forbidden('Solo se puede resetear la contraseña de un socio');

    const password = PASSWORD_TEMPORAL;
    const emailLc = String(socio.email ?? '').trim().toLowerCase();
    const emailValido = EMAIL_RE.test(emailLc) && !emailLc.endsWith('@sin-correo.local');

    if (socio.auth_id) {
      // 3a) Tiene cuenta → reset de clave + sincronizar el email de la cuenta con
      //     el de la ficha (si no coincidían, por eso no entraba con su correo).
      const upd: { password: string; email?: string; email_confirm?: boolean } =
        emailValido ? { password, email: emailLc, email_confirm: true } : { password };
      let { error: updErr } = await admin.auth.admin.updateUserById(socio.auth_id, upd);
      if (updErr && upd.email) {
        // El email pudo fallar (ya tomado por otra cuenta): al menos deja la clave.
        console.error('[reset] no se pudo sincronizar el email:', updErr.message);
        ({ error: updErr } = await admin.auth.admin.updateUserById(socio.auth_id, { password }));
      }
      if (updErr) return serverError(updErr.message);
    } else {
      // 3b) Ficha SIN login → crear la cuenta (como "dar acceso") para que entre.
      if (!emailValido) {
        return badRequest('Este socio no tiene un correo válido. Edita su correo y vuelve a intentar.');
      }
      const { data: tenant } = await admin
        .from('tenants')
        .select('slug')
        .eq('id', socio.tenant_id)
        .maybeSingle();
      if (!tenant?.slug) return serverError('No se pudo resolver el gimnasio');

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email: emailLc,
        password,
        email_confirm: true,
        user_metadata: { tenant_slug: tenant.slug, nombre: socio.nombre ?? undefined }
      });
      if (authErr || !authData?.user) {
        const msg = (authErr?.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
          return badRequest('Ya existe una cuenta con ese correo pero no está ligada a esta ficha. Probablemente hay una ficha duplicada; avísame para unirlas.');
        }
        return serverError('No pudimos crear el acceso.');
      }
      // Ligar la ficha a la cuenta nueva (el trigger hizo ON CONFLICT DO NOTHING).
      await admin.from('usuarios').update({ auth_id: authData.user.id }).eq('id', socio.id).is('auth_id', null);
    }

    // Aviso EN-APP para forzar el cambio (solo en-app, no push).
    await admin.from('notificaciones').insert({
      tenant_id: staff.tenant_id,
      usuario_id: socio.id,
      tipo: 'cambiar_password',
      titulo: 'Cambia tu contraseña',
      mensaje: 'Tu contraseña se restableció a una temporal. Por tu seguridad, cámbiala ahora por una tuya.',
      push_enviado_at: new Date().toISOString()
    } as never);

    // 4) Bitácora (actor = el staff que pidió; resuelto acá porque un RPC no
    //    puede leer auth.uid() bajo service_role).
    await admin.from('auditoria_recepcion').insert({
      tenant_id: staff.tenant_id,
      actor_id: staff.id,
      actor_nombre: staff.nombre,
      actor_rol: staff.rol,
      accion: 'socio.reset_password',
      entidad: 'socio',
      entidad_id: socio.id,
      socio_id: socio.id,
      socio_nombre: socio.nombre,
      resumen: `Reseteó la contraseña de ${socio.nombre ?? socio.email}.`
    });

    return ok({ password });
  } catch (err) {
    console.error('[reception-reset-password]', err instanceof Error ? err.message : err);
    return serverError('No pudimos resetear la contraseña');
  }
};
