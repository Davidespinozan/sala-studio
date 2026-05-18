import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /qr-issue
 * Body: { reserva_id: string }
 * Auth: Bearer JWT del miembro dueño de la reserva
 *
 * Devuelve un JWT firmado server-side que contiene { reserva_id, tenant_id, exp }
 * Expira 30 min después del slot_fin de la reserva.
 */

interface IssueRequest {
  reserva_id: string;
}

interface IssueResponse {
  qr_payload: string; // string a codificar en el QR
  expires_at: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return badRequest('Method not allowed');
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return unauthorized('Missing bearer token');
    }
    const userToken = authHeader.slice('Bearer '.length);

    const body: IssueRequest = JSON.parse(event.body || '{}');
    if (!body.reserva_id) return badRequest('reserva_id required');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const jwtSecret = requireEnv('QR_JWT_SECRET');

    // Cliente con token del usuario (respeta RLS)
    const supabase = createClient(supabaseUrl, anonKey, {      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    // Buscar reserva (RLS valida que sea suya)
    const { data: reserva, error } = await supabase
      .from('reservas')
      .select('id, tenant_id, usuario_id, slot_inicio, slot_fin, status')
      .eq('id', body.reserva_id)
      .maybeSingle();

    if (error || !reserva) {
      return unauthorized('Reserva no encontrada o no autorizada');
    }

    if (reserva.status === 'cancelada') {
      return badRequest('La reserva está cancelada');
    }

    // Calcular expiración: slot_fin + 30 min
    const slotFin = new Date(reserva.slot_fin);
    const expiresAt = new Date(slotFin.getTime() + 30 * 60 * 1000);

    // Firmar JWT manualmente (HMAC-SHA256)
    const payload = {
      reserva_id: reserva.id,
      tenant_id: reserva.tenant_id,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000)
    };

    const jwt = await signJWT(payload, jwtSecret);

    return ok<IssueResponse>({
      qr_payload: jwt,
      expires_at: expiresAt.toISOString()
    });
  } catch (e) {
    console.error('[qr-issue]', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};

/**
 * JWT HS256 manual (sin dependencia externa para mantener el bundle chico).
 */
async function signJWT(payload: object, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmacSHA256(data, secret);
  return `${data}.${signature}`;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hmacSHA256(data: string, secret: string): Promise<string> {
  const crypto = await import('node:crypto');
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
