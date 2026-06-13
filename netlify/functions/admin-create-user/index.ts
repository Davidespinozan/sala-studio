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
 * POST /admin-create-user
 * Auth: Bearer JWT del admin
 * Body: { email, password, nombre, telefono?, rol, membresia_tier? }
 *
 * Crea cuenta en Supabase Auth + fila en usuarios del MISMO tenant del admin.
 * Roles permitidos: 'miembro' | 'recepcionista' | 'staff' | 'admin'
 * Si rol === 'miembro', membresia_tier puede ser 'basica' | 'pro' o null
 */

interface CreateRequest {
  email: string;
  password: string;
  nombre: string;
  telefono?: string;
  rol: 'miembro' | 'recepcionista' | 'staff' | 'admin';
  membresia_tier?: 'basica' | 'pro' | null;
}

// 'staff' desactivado (rol a medias sin UI propia) — se rechaza al crear.
const ROLES_VALIDOS: readonly string[] = ['miembro', 'recepcionista', 'admin'];

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: CreateRequest = JSON.parse(event.body || '{}');

    // Validación de input
    if (!body.email?.includes('@')) return badRequest('Email inválido');
    if (!body.password || body.password.length < 8) return badRequest('Password debe tener al menos 8 caracteres');
    if (!body.nombre?.trim()) return badRequest('Nombre requerido');
    if (!ROLES_VALIDOS.includes(body.rol)) return badRequest(`Rol inválido: ${body.rol}`);

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // Cliente con token del admin (para validar quién es)
    const supabaseAsUser = createClient(supabaseUrl, anonKey, {      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    // Verificar que es admin del tenant
    const { data: adminProfile } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    // status='activo': un admin revocado/suspendido no debe poder operar (fix C2).
    if (!adminProfile || adminProfile.rol !== 'admin' || adminProfile.status !== 'activo') {
      return forbidden('Solo admin puede crear usuarios');
    }

    const tenantId = adminProfile.tenant_id;

    // Cliente con service_role (bypasea RLS para crear cuentas)
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {      auth: { persistSession: false }
    });

    // 1. Crear cuenta en Auth con email confirmado (no manda email)
    const { data: newAuthUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: body.email.trim().toLowerCase(),
      password: body.password,
      email_confirm: true,
      user_metadata: {
        tenant_slug: 'sala-demo', // el trigger lo usa, pero el INSERT manual de abajo lo sobrescribe
        nombre: body.nombre.trim(),
        telefono: body.telefono?.trim() || null
      }
    });

    if (createErr) {
      const msg = createErr.message.toLowerCase();
      if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
        // ¿La persona ya existe en ESTE tenant con acceso desactivado? Entonces
        // el camino correcto es reactivarla desde su ficha, no crearla otra vez
        // (el email queda "quemado" por el soft-revoke). Guiamos en consecuencia.
        const emailLc = body.email.trim().toLowerCase();
        const { data: existente } = await supabaseAdmin
          .from('usuarios')
          .select('status')
          .eq('tenant_id', tenantId)
          .eq('email', emailLc)
          .maybeSingle();
        if (existente && ['revocado', 'suspendido', 'cancelado'].includes(existente.status)) {
          return badRequest(
            'Esa persona ya está en tu equipo pero con el acceso desactivado. Reactivá su cuenta desde su ficha en lugar de crearla otra vez.'
          );
        }
        return badRequest('Ya existe una cuenta con ese email');
      }
      return serverError(createErr.message);
    }

    if (!newAuthUser?.user) return serverError('No se pudo crear la cuenta');

    // 2. El trigger on_auth_user_created ya insertó fila en `usuarios` con rol='miembro'.
    //    Actualizar a los valores reales (rol + tier + status).
    const status = body.rol === 'miembro' ? 'pendiente_pago' : 'activo';

    const { data: updatedRow, error: updateErr } = await supabaseAdmin
      .from('usuarios')
      .update({
        rol: body.rol,
        membresia_tier: body.rol === 'miembro' ? (body.membresia_tier ?? null) : null,
        status,
        nombre: body.nombre.trim(),
        telefono: body.telefono?.trim() || null,
        tenant_id: tenantId
      })
      .eq('auth_id', newAuthUser.user.id)
      .select('id')
      .single();

    if (updateErr || !updatedRow) {
      // Best-effort: limpiar el auth user creado
      await supabaseAdmin.auth.admin.deleteUser(newAuthUser.user.id);
      return serverError(`No se pudo asignar el rol: ${updateErr?.message ?? 'fila no encontrada'}`);
    }

    return ok({
      success: true,
      user: {
        id: updatedRow.id, // necesario para alta de membresía vía gestionar_membresia_socio
        email: body.email.trim().toLowerCase(),
        nombre: body.nombre.trim(),
        rol: body.rol,
        password: body.password // devolver para que admin pueda compartirla
      }
    });
  } catch (e) {
    console.error('[admin-create-user]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
