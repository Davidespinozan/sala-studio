import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /reception-reset-password — Recepción/admin genera una contraseña
 * TEMPORAL para un socio que quedó afuera del login (en el mostrador).
 * Auth: Bearer JWT del staff. Body: { usuario_id }.
 * Gate: caller recepcionista/admin activo + mismo tenant; target rol 'miembro'.
 * Devuelve { password } para entregársela. Queda en la bitácora.
 */

interface Body { usuario_id?: string }

function generarPassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

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
    if (!socio.auth_id) return badRequest('El socio no tiene cuenta de acceso.');

    // 3) Password temporal.
    const password = generarPassword();
    const { error: updErr } = await admin.auth.admin.updateUserById(socio.auth_id, { password });
    if (updErr) return serverError(updErr.message);

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
