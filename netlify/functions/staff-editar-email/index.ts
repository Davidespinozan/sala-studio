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
 * POST /staff-editar-email — recepción/admin cambia el email de un socio BIEN:
 * el de ACCESO (auth.users) y el de la ficha (usuarios) a la vez, para que no se
 * desincronicen. Auth: Bearer JWT del staff. Body: { usuario_id, email }.
 *
 * Editar solo usuarios.email dejaba al socio logueándose con el email VIEJO (el
 * de auth no cambiaba). Acá se cambian los dos. Si el socio aún no tiene login,
 * solo se pone en la ficha (cuando active, el login usará ese email).
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

    const { usuario_id, email } = JSON.parse(event.body || '{}') as { usuario_id?: string; email?: string };
    const emailLc = String(email ?? '').trim().toLowerCase();
    if (!usuario_id) return badRequest('Falta el socio');
    if (!EMAIL_RE.test(emailLc)) return badRequest('El email no tiene un formato válido');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // ── Staff que pide ───────────────────────────────────────────────────────
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
    if (!staff || !['recepcionista', 'admin'].includes(staff.rol as string) || staff.status !== 'activo') {
      return forbidden('Solo recepción o admin pueden editar el email');
    }

    // ── Socio destino ────────────────────────────────────────────────────────
    const { data: socio } = await admin
      .from('usuarios')
      .select('id, tenant_id, auth_id, email, notas_admin')
      .eq('id', usuario_id)
      .maybeSingle();
    if (!socio) return badRequest('Socio no encontrado');
    if (socio.tenant_id !== staff.tenant_id) return forbidden('Ese socio es de otro gimnasio');

    // El email no puede estar tomado por OTRA ficha del gym.
    const { data: enUso } = await admin
      .from('usuarios')
      .select('id')
      .eq('tenant_id', socio.tenant_id)
      .eq('email', emailLc)
      .neq('id', socio.id)
      .maybeSingle();
    if (enUso) return badRequest('Ese email ya lo usa otro socio de tu gym');

    // ── 1) El email de ACCESO (auth), si tiene login ─────────────────────────
    if (socio.auth_id) {
      const { error: authErr } = await admin.auth.admin.updateUserById(socio.auth_id, {
        email: emailLc,
        email_confirm: true
      });
      if (authErr) {
        const msg = (authErr.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
          return CONFLICT('Ese email ya está registrado en otra cuenta.', 'EMAIL_TOMADO');
        }
        return serverError('No pudimos cambiar el email de acceso.');
      }
    }

    // ── 2) El email de la ficha (usuarios) + limpiar la nota de "sin correo" ──
    const eraSinCorreo = String(socio.email ?? '').toLowerCase().endsWith('@sin-correo.local');
    const patch: Record<string, unknown> = { email: emailLc };
    if (eraSinCorreo) patch.notas_admin = null; // ya tiene correo real → fuera la marca de importación
    const { error: updErr } = await admin.from('usuarios').update(patch as never).eq('id', socio.id);
    if (updErr) return serverError('No pudimos guardar el email en la ficha.');

    return ok({ success: true, email: emailLc });
  } catch (err) {
    console.error('[staff-editar-email]', err instanceof Error ? err.message : err);
    return serverError('No pudimos editar el email');
  }
};