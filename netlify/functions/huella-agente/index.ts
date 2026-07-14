import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22 no hay
// WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { cifrarPlantilla, descifrarPlantilla } from '../_lib/huellaCrypto';

/**
 * POST /huella-agente — la única puerta del agente local del lector.
 *
 * El agente es el programita que corre en la compu del mostrador: habla con el
 * lector USB por un lado (driver del fabricante) y con nosotros por el otro.
 * Se identifica con el token que el admin copió al dar de alta el lector.
 *
 * Tres cosas necesita, y ninguna más:
 *
 *   { "accion": "sync",     "token": "..." }
 *      → las huellas del gym, DESCIFRADAS, para poder comparar localmente.
 *
 *   { "accion": "pendiente","token": "..." }
 *      → "¿hay alguien esperando para poner el dedo?" (recepción abrió una toma)
 *
 *   { "accion": "enrolar",  "token": "...", "enrolamiento_id": "...",
 *     "plantilla": "<base64>", "formato": "iso19794-2", "calidad": 88 }
 *      → cerramos la toma guardando la huella CIFRADA.
 *
 * El cifrado pasa acá. La llave (HUELLA_ENCRYPTION_KEY) vive en Netlify, nunca en
 * Supabase: un backup filtrado de la base no alcanza para leer una sola huella.
 */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body || '{}') as Record<string, unknown>;
    } catch {
      return badRequest('Body inválido');
    }

    const accion = typeof body.accion === 'string' ? body.accion : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return unauthorized('Falta el token del lector');

    const supabase = createClient(
      requireEnv('SUPABASE_URL'),
      // service_role: estas funciones no se le conceden a nadie más. Si el
      // navegador pudiera llamarlas, cualquiera se bajaría las huellas del gym.
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } }
    );

    if (accion === 'sync') {
      const { data, error } = await supabase.rpc('sincronizar_plantillas' as never, {
        p_token: token
      } as never);
      if (error) return errorDelLector(error.message);

      const res = data as { huellas: { usuario_id: string; dedo: string; formato: string; plantilla: string }[] };

      // Descifrar acá y mandárselas al agente por HTTPS. Es la única forma de que
      // pueda comparar: el motor de matching lo trae el driver del lector.
      return ok({
        ok: true,
        huellas: res.huellas.map((h) => ({
          usuario_id: h.usuario_id,
          dedo: h.dedo,
          formato: h.formato,
          plantilla: descifrarPlantilla(h.plantilla)
        }))
      });
    }

    if (accion === 'pendiente') {
      const { data, error } = await supabase.rpc('enrolamiento_pendiente' as never, {
        p_token: token
      } as never);
      if (error) return errorDelLector(error.message);
      return ok({ ok: true, ...(data as Record<string, unknown>) });
    }

    if (accion === 'enrolar') {
      const enrolamientoId = typeof body.enrolamiento_id === 'string' ? body.enrolamiento_id : '';
      const plantilla = typeof body.plantilla === 'string' ? body.plantilla : '';
      const formato = typeof body.formato === 'string' ? body.formato : 'iso19794-2';
      const calidad = typeof body.calidad === 'number' ? Math.round(body.calidad) : null;

      if (!enrolamientoId) return badRequest('Falta el id de la toma de huella');
      if (!plantilla) return badRequest('Falta la plantilla');

      const { data, error } = await supabase.rpc('completar_enrolamiento_huella' as never, {
        p_token: token,
        p_enrolamiento_id: enrolamientoId,
        p_plantilla_cifrada: cifrarPlantilla(plantilla),
        p_formato: formato,
        p_calidad: calidad
      } as never);
      if (error) return errorDelLector(error.message);
      return ok({ ok: true, ...(data as Record<string, unknown>) });
    }

    return badRequest('Acción desconocida');
  } catch (err) {
    console.error('[huella-agente]', err);
    return serverError('Error inesperado');
  }
};

/** El agente muestra esto en la pantalla del mostrador. El detalle queda en el log. */
function errorDelLector(mensaje: string) {
  console.error('[huella-agente]', mensaje);
  const codigo = mensaje.split(':')[0] ?? '';
  const status =
    codigo.includes('LECTOR_DESCONOCIDO') || codigo.includes('LECTOR_INACTIVO') ? 401 : 400;
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: false, codigo, mensaje: mensaje.split(':').slice(1).join(':').trim() })
  };
}
