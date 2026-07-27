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
 * POST /importar-miembros — alta masiva de socios migrados de otro sistema.
 * Auth: Bearer JWT del ADMIN.
 * Body: { rows: [{ nombre, email, telefono?, tier_id, vencimiento?, creditos? }] }
 *
 * Valida que quien importa sea admin activo del tenant, y llama a la RPC
 * importar_miembros (service_role) que hace el trabajo por fila (dedup, valida
 * plan, crea usuario sin auth + membresía con vencimiento, sin cobrar).
 * Devuelve el resumen { creados, omitidos, errores, detalle }.
 */

// Tope defensivo por request (la UI trocea lotes grandes).
const MAX_FILAS = 2000;

interface Fila {
  nombre?: string;
  email?: string;
  telefono?: string;
  tier_id?: string;
  vencimiento?: string;
  creditos?: string | number;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body = JSON.parse(event.body || '{}') as { rows?: Fila[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) return badRequest('No hay filas para importar');
    if (rows.length > MAX_FILAS) return badRequest(`Máximo ${MAX_FILAS} filas por lote`);

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // 1) Identificar y autorizar: solo un admin ACTIVO del tenant importa.
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: admin } = await asUser
      .from('usuarios')
      .select('tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!admin) return forbidden('Sin perfil');
    if (admin.rol !== 'admin' || admin.status !== 'activo') {
      return forbidden('Solo un admin puede importar miembros');
    }

    // 2) Normalizar filas: solo las llaves que la RPC entiende (nunca confiar en
    //    el cliente para el tenant). tier_id/vencimiento/creditos como strings;
    //    la RPC los castea y valida.
    const limpias = rows.map((r) => ({
      nombre: String(r.nombre ?? '').trim(),
      email: String(r.email ?? '').trim(),
      telefono: String(r.telefono ?? '').trim(),
      tier_id: String(r.tier_id ?? '').trim(),
      vencimiento: String(r.vencimiento ?? '').trim(),
      creditos: r.creditos === undefined || r.creditos === null ? '' : String(r.creditos).trim()
    }));

    const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await service.rpc('importar_miembros', {
      p_tenant_id: admin.tenant_id,
      p_rows: limpias
    });
    if (error) return serverError(error.message);

    return ok(data as object);
  } catch (err) {
    console.error('[importar-miembros]', err instanceof Error ? err.message : err);
    return serverError('No pudimos completar la importación');
  }
};
