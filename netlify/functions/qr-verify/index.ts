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
 * POST /qr-verify
 * Body: { qr_payload: string }
 * Auth: Bearer JWT del recepcionista
 *
 * Valida el JWT del QR, llama al RPC check_in_atomic, devuelve datos del miembro.
 */

interface VerifyRequest {
  qr_payload: string;
}

interface JWTPayload {
  reserva_id: string;
  tenant_id: string;
  iat: number;
  exp: number;
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

    const body: VerifyRequest = JSON.parse(event.body || '{}');
    if (!body.qr_payload) return badRequest('qr_payload required');

    const jwtSecret = requireEnv('QR_JWT_SECRET');

    // Validar JWT
    const payload = await verifyJWT(body.qr_payload, jwtSecret);
    if (!payload) {
      return ok({
        success: false,
        error: 'EKKO_QR_INVALIDO',
        message: 'QR inválido o firma incorrecta'
      });
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return ok({
        success: false,
        error: 'EKKO_QR_EXPIRADO',
        message: 'Este QR ya expiró'
      });
    }

    // Llamar al RPC check_in_atomic con el token del recepcionista
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const supabase = createClient(supabaseUrl, anonKey, {      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    const { data, error } = await supabase.rpc('check_in_atomic', {
      p_reserva_id: payload.reserva_id
    });

    if (error) {
      // Traducir errores EKKO_*
      const msg = error.message || '';
      const errorCode = msg.match(/EKKO_[A-Z_]+/)?.[0] ?? 'EKKO_ERROR_DESCONOCIDO';
      return ok({
        success: false,
        error: errorCode,
        message: translateError(errorCode, msg)
      });
    }

    return ok({
      success: true,
      data
    });
  } catch (e) {
    console.error('[qr-verify]', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};

async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    const data = `${encodedHeader}.${encodedPayload}`;
    const expected = await hmacSHA256(data, secret);

    // Comparación timing-safe
    if (signature.length !== expected.length) return null;
    let mismatch = 0;
    for (let i = 0; i < signature.length; i++) {
      mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (mismatch !== 0) return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    return payload as JWTPayload;
  } catch {
    return null;
  }
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4;
  const padded = input + '='.repeat(pad === 0 ? 0 : 4 - pad);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
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

function translateError(code: string, fallback: string): string {
  const map: Record<string, string> = {
    EKKO_RESERVA_NO_EXISTE: 'Reserva no encontrada',
    EKKO_TENANT_DIFERENTE: 'Esta reserva no es de este tenant',
    EKKO_YA_CHECK_IN: 'Este miembro ya hizo check-in',
    EKKO_RESERVA_CANCELADA: 'Reserva cancelada',
    EKKO_RESERVA_NO_SHOW: 'Reserva marcada como inasistencia',
    EKKO_DEMASIADO_TEMPRANO: 'Es muy temprano para el check-in',
    EKKO_DEMASIADO_TARDE: 'El check-in ya cerró',
    EKKO_NO_AUTORIZADO: 'No autorizado',
    EKKO_QR_INVALIDO: 'QR inválido',
    EKKO_QR_EXPIRADO: 'QR expirado'
  };
  return map[code] ?? fallback.replace(code + ':', '').trim() ?? fallback;
}
