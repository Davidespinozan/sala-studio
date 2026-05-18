import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler, HandlerResponse } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /admin-delete-user
 * Auth: Bearer JWT del admin
 * Body: { usuarioId: string }
 *
 * Hard delete real vía auth.admin.deleteUser → libera email para re-uso
 * inmediato (auth.users tiene UNIQUE en email).
 *
 * Guards:
 *   - Caller debe ser admin del tenant del target (no cross-tenant)
 *   - No auto-delete
 *   - No último admin del tenant
 *   - No si target tiene reservas (FK RESTRICT preserva folios/check-ins).
 *     En ese caso → 409 con { reservas_count } y el admin debe usar
 *     "revocar" (soft, status='revocado') en lugar.
 */

interface DeleteRequest {
  usuarioId: string;
}

const CONFLICT = (body: { error: string; reservas_count: number }): HandlerResponse => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: DeleteRequest = JSON.parse(event.body || '{}');
    if (!body.usuarioId) return badRequest('usuarioId requerido');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // Cliente con token del admin (para validar quién es)
    const supabaseAsUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    // Cliente service_role (bypasea RLS para todos los lookups y deletes)
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    // Verificar caller es admin
    const { data: adminProfile } = await supabaseAdmin
      .from('usuarios')
      .select('id, tenant_id, rol, auth_id')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (!adminProfile || adminProfile.rol !== 'admin') {
      return forbidden('Solo admin puede eliminar usuarios');
    }

    // Lookup target
    const { data: targetUser } = await supabaseAdmin
      .from('usuarios')
      .select('id, tenant_id, rol, auth_id, email, status')
      .eq('id', body.usuarioId)
      .maybeSingle();

    if (!targetUser) return badRequest('Usuario no encontrado');

    // Mismo tenant
    if (targetUser.tenant_id !== adminProfile.tenant_id) {
      return forbidden('Usuario de otro tenant');
    }

    // No auto-delete
    if (targetUser.id === adminProfile.id) {
      return forbidden('No podés eliminarte a vos mismo');
    }

    // Si es admin, no puede ser el último activo
    if (targetUser.rol === 'admin') {
      const { count } = await supabaseAdmin
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', adminProfile.tenant_id)
        .eq('rol', 'admin')
        .neq('status', 'cancelado');

      if ((count ?? 0) <= 1) {
        return forbidden('No podés eliminar el último admin del gimnasio');
      }
    }

    // Pre-check reservas (FK RESTRICT preserva folios/check-ins)
    const { count: reservasCount } = await supabaseAdmin
      .from('reservas')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', targetUser.id);

    if ((reservasCount ?? 0) > 0) {
      return CONFLICT({
        error: `Tiene ${reservasCount} ${reservasCount === 1 ? 'reserva' : 'reservas'} en historial. Cancelá o usá "Revocar acceso" en lugar de eliminar.`,
        reservas_count: reservasCount ?? 0
      });
    }

    // Hard delete via auth admin (cascadea a la fila de usuarios vía
    // ON DELETE CASCADE en usuarios.auth_id → auth.users)
    if (targetUser.auth_id) {
      const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(
        targetUser.auth_id
      );

      if (authDeleteError) {
        return serverError(`Error eliminando cuenta auth: ${authDeleteError.message}`);
      }
    } else {
      // Sin auth_id (mock o invitado sin signup): borrar la fila directo
      const { error: dbError } = await supabaseAdmin
        .from('usuarios')
        .delete()
        .eq('id', targetUser.id);

      if (dbError) {
        return serverError(`Error eliminando fila: ${dbError.message}`);
      }
    }

    return ok({ success: true, email: targetUser.email });
  } catch (e) {
    console.error('[admin-delete-user]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
