import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22 no hay
// WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /checkin-lector — el socio apoyó el dedo y entró.
 *
 *   { "token": "<el del lector>", "usuario_id": "<uuid>", "momento": "2026-07-16T07:03:00Z" }
 *
 * El agente local YA comparó la huella contra las plantillas que se bajó de
 * `sync`, así que acá no llega ninguna huella: llega un nombre. Nosotros
 * verificamos que ese socio tenga efectivamente una huella viva en este gym (si
 * no, un agente comprometido podría hacer entrar a cualquiera) y buscamos a qué
 * clase está entrando.
 *
 * `momento` lo manda el agente porque la compu del mostrador pudo estar sin
 * internet un rato y descargar las entradas después. Si no viene, es ahora.
 *
 * El check-in que dispara es EL MISMO que el del QR, con las mismas reglas
 * (ventana del gym, sede del lector, reserva confirmada). La huella no es una
 * puerta nueva ni una llave maestra: sin reserva, no se entra.
 */

function mensajeParaElMostrador(codigo: string): { mensaje: string; status: number } {
  if (codigo.includes('LECTOR_DESCONOCIDO') || codigo.includes('LECTOR_INACTIVO')) {
    return { mensaje: 'Lector no autorizado', status: 401 };
  }
  if (codigo.includes('HUELLA_NO_RECONOCIDA')) {
    return { mensaje: 'Huella no registrada', status: 404 };
  }
  if (codigo.includes('SIN_RESERVA')) {
    return { mensaje: 'Sin reserva a esta hora', status: 409 };
  }
  return { mensaje: 'No se pudo registrar la entrada', status: 400 };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}') as Record<string, unknown>;
    } catch {
      return badRequest('Body inválido');
    }

    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const usuarioId = typeof body.usuario_id === 'string' ? body.usuario_id.trim() : '';
    const momento = typeof body.momento === 'string' ? body.momento : '';

    if (!token) return badRequest('Falta el token del lector');
    if (!usuarioId) return badRequest('Falta el socio que reconoció el lector');

    const at = momento ? new Date(momento) : new Date();
    if (Number.isNaN(at.getTime())) return badRequest('El momento no es una fecha válida');

    const supabase = createClient(
      requireEnv('VITE_SUPABASE_URL'),
      // service_role: check_in_por_huella no se le concede a nadie más. Si el
      // navegador pudiera llamarla, cualquiera con el token del lector marcaría
      // entradas desde su casa.
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } }
    );

    const { data, error } = await supabase.rpc('check_in_por_huella' as never, {
      p_token: token,
      p_usuario_id: usuarioId,
      p_at: at.toISOString()
    } as never);

    if (error) {
      const { mensaje, status } = mensajeParaElMostrador(error.message ?? '');
      console.error('[checkin-lector]', error.message);
      return {
        statusCode: status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, mensaje })
      };
    }

    const res = data as {
      socio?: { nombre?: string | null };
      clase?: string | null;
      hora?: string | null;
    } | null;

    return ok({
      ok: true,
      mensaje: `Hola ${res?.socio?.nombre ?? ''}`.trim(),
      clase: res?.clase ?? null,
      hora: res?.hora ?? null
    });
  } catch (err) {
    console.error('[checkin-lector]', err);
    return serverError('Error inesperado');
  }
};
