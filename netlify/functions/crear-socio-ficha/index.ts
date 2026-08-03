import ws from 'ws';
// supabase-js arranca Realtime aunque no lo usemos; en Node <22 no hay WebSocket
// global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /crear-socio-ficha — recepción/admin dan de alta un socio creando SOLO su
 * ficha (sin login). Auth: Bearer JWT del staff. Body:
 *   { nombre, email, telefono?, sucursal_id? }
 *
 * A propósito NO crea la cuenta de acceso: el gym solo le dice al socio "ya puedes
 * activar tu cuenta"; el socio va a /activar con su email, y AHÍ el sistema le crea
 * el login y le muestra su contraseña temporal (Cambiar123). Así el gym nunca tiene
 * que dictar la contraseña.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const { nombre, email, telefono, sucursal_id } = JSON.parse(event.body || '{}') as {
      nombre?: string; email?: string; telefono?: string; sucursal_id?: string | null;
    };
    const nombreT = String(nombre ?? '').trim();
    const emailLc = String(email ?? '').trim().toLowerCase();
    if (nombreT.length < 2) return badRequest('Falta el nombre');
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
      return forbidden('Solo recepción o admin pueden dar de alta socios');
    }

    // El email no puede estar ya en el gym.
    const { data: enUso } = await admin
      .from('usuarios')
      .select('id')
      .eq('tenant_id', staff.tenant_id)
      .eq('email', emailLc)
      .maybeSingle();
    if (enUso) return badRequest('Ya hay un socio con ese email en tu gym');

    // Sede (opcional): debe ser del gym.
    let sedeId: string | null = null;
    if (sucursal_id) {
      const { data: suc } = await admin
        .from('sucursales')
        .select('id')
        .eq('id', sucursal_id)
        .eq('tenant_id', staff.tenant_id)
        .maybeSingle();
      sedeId = suc?.id ?? null;
    }

    // ── Crear la ficha SIN login (auth_id null). Pendiente de pago hasta que se
    //    le asigne un plan (el modal lo hace enseguida si el gym elige uno). ────
    const { data: ficha, error: insErr } = await admin
      .from('usuarios')
      .insert({
        tenant_id: staff.tenant_id,
        nombre: nombreT,
        email: emailLc,
        telefono: String(telefono ?? '').trim() || null,
        rol: 'miembro',
        status: 'pendiente_pago',
        sucursal_id: sedeId
      } as never)
      .select('id, email')
      .single();
    if (insErr || !ficha) {
      return serverError(insErr?.message ?? 'No pudimos crear la ficha del socio.');
    }

    return ok({ usuario_id: ficha.id, email: ficha.email });
  } catch (err) {
    console.error('[crear-socio-ficha]', err instanceof Error ? err.message : err);
    return serverError('No pudimos crear al socio');
  }
};