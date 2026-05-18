import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /admin-update-role
 * Auth: Bearer JWT del admin
 * Body: { usuario_id, rol }
 *
 * Cambia el rol de un usuario, validando:
 * - Solo admin del tenant puede hacerlo
 * - No permite demotion del último admin del tenant
 * - El target debe ser del mismo tenant
 */

interface UpdateRoleRequest {
  usuario_id: string;
  rol: 'miembro' | 'recepcionista' | 'staff' | 'admin';
}

const ROLES_VALIDOS = ['miembro', 'recepcionista', 'staff', 'admin'] as const;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: UpdateRoleRequest = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('usuario_id requerido');
    if (!ROLES_VALIDOS.includes(body.rol)) return badRequest(`Rol inválido: ${body.rol}`);

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabaseAsUser = createClient(supabaseUrl, anonKey, {      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: adminProfile } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (!adminProfile || adminProfile.rol !== 'admin') {
      return forbidden('Solo admin puede cambiar roles');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {      auth: { persistSession: false }
    });

    // Obtener usuario target
    const { data: target, error: targetErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, tenant_id, rol, email')
      .eq('id', body.usuario_id)
      .maybeSingle();

    if (targetErr || !target) return badRequest('Usuario no encontrado');

    if (target.tenant_id !== adminProfile.tenant_id) {
      return forbidden('Usuario es de otro tenant');
    }

    // Si demote de admin → otro rol, validar que NO sea el último admin
    if (target.rol === 'admin' && body.rol !== 'admin') {
      const { data: count } = await supabaseAdmin.rpc('count_active_admins', {
        p_tenant_id: adminProfile.tenant_id
      });

      if ((count ?? 0) <= 1) {
        return badRequest('No puedes quitar al último admin del tenant');
      }
    }

    const { error: updateErr } = await supabaseAdmin
      .from('usuarios')
      .update({ rol: body.rol })
      .eq('id', body.usuario_id);

    if (updateErr) return serverError(updateErr.message);

    return ok({ success: true, usuario_id: body.usuario_id, rol: body.rol });
  } catch (e) {
    console.error('[admin-update-role]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
