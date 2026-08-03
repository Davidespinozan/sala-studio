import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import { createHmac } from 'node:crypto';
import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, notFound, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /recibo-token — devuelve el token firmado del recibo de un pago (para armar
 * el link público /recibo/<id>?t=<token>) y, si quien pide es staff, el teléfono
 * del socio para el botón de WhatsApp. Auth: Bearer JWT.
 *
 * Autorizado para: staff (recepcionista/admin) del gym del pago, o el propio socio
 * dueño del pago. El token es HMAC(pago_id) con el service_role como llave: no se
 * puede adivinar y no expone la llave (HMAC es de una vía).
 */

/** Debe coincidir con folioDePago/reciboUrl del front (mismo algoritmo de token). */
function firmarRecibo(pagoId: string, secret: string): string {
  return createHmac('sha256', secret).update(pagoId).digest('base64url').slice(0, 24);
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const { pago_id } = JSON.parse(event.body || '{}') as { pago_id?: string };
    if (!pago_id) return badRequest('Falta el pago');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: uErr } = await asUser.auth.getUser();
    if (uErr || !authUser) return unauthorized('Token inválido');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: pago } = await admin
      .from('pagos')
      .select('id, tenant_id, usuario_id')
      .eq('id', pago_id)
      .maybeSingle();
    if (!pago) return notFound('No encontramos ese pago');

    const { data: quien } = await admin
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!quien) return forbidden('Sin acceso');

    const esStaff =
      quien.tenant_id === pago.tenant_id &&
      ['recepcionista', 'admin'].includes(quien.rol as string) &&
      quien.status === 'activo';
    const esDueno = quien.id === pago.usuario_id;
    if (!esStaff && !esDueno) return forbidden('Este recibo no es tuyo');

    const token = firmarRecibo(pago.id, serviceKey);

    // El teléfono (para WhatsApp) solo se lo damos al staff.
    let telefono: string | null = null;
    if (esStaff) {
      const { data: socio } = await admin
        .from('usuarios')
        .select('telefono')
        .eq('id', pago.usuario_id)
        .maybeSingle();
      telefono = (socio?.telefono as string | null) || null;
    }

    return ok({ token, telefono });
  } catch (err) {
    console.error('[recibo-token]', err instanceof Error ? err.message : err);
    return serverError('No pudimos generar el recibo');
  }
};