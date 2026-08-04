import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /recibo-token — devuelve el token firmado del recibo de un pago (para armar
 * el link público /recibo/<id>?t=<token>) y el teléfono del socio (para WhatsApp).
 * Auth: Bearer JWT.
 *
 * Autorización por RLS (como qr-issue): consultamos `pagos` CON EL TOKEN DEL
 * USUARIO. Si la fila vuelve, el caller puede verla (es el dueño por
 * pagos_read_self, o staff del gym por pagos_read_staff) → tiene derecho al
 * recibo. Si no vuelve, no está autorizado. El token es HMAC(pago_id) con el
 * service_role como llave: no se puede adivinar y no expone la llave.
 */

async function firmarRecibo(pagoId: string, secret: string): Promise<string> {
  const { createHmac } = await import('node:crypto');
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

    // Cliente con el token del usuario → RLS decide qué puede ver.
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    // RLS autoriza: solo vuelve la fila si el caller es dueño del pago o staff del gym.
    const { data: pago, error: pErr } = await asUser
      .from('pagos')
      .select('id, usuario_id')
      .eq('id', pago_id)
      .maybeSingle();
    if (pErr) {
      console.error('[recibo-token] pago:', pErr.message);
      return serverError('No pudimos generar el recibo');
    }
    if (!pago) return forbidden('Este recibo no está disponible para tu cuenta');

    const token = await firmarRecibo(pago.id as string, serviceKey);

    // Teléfono del socio para el botón de WhatsApp. Via RLS: staff lee el del
    // miembro; un socio lee el suyo (inofensivo, ya lo conoce).
    const { data: socio } = await asUser
      .from('usuarios')
      .select('telefono')
      .eq('id', pago.usuario_id as string)
      .maybeSingle();
    const telefono = (socio?.telefono as string | null) || null;

    return ok({ token, telefono });
  } catch (err) {
    console.error('[recibo-token]', err instanceof Error ? err.message : err);
    return serverError('No pudimos generar el recibo');
  }
};