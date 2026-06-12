// Traduce códigos de error de los RPCs de ACCIONES de recepción (escrituras) a
// español. Gemelo de traducirErrorLectura.ts (lecturas), pero para acciones.
// Los RPCs lanzan `RAISE EXCEPTION 'CODIGO: mensaje'`; Supabase lo trae en
// error.message. Acá extraemos el código y lo mapeamos. Extender = sumar al map.

export const ERROR_CODE_MAP: Record<string, string> = {
  // Generales
  NO_AUTORIZADO: 'No tenés permiso para esta acción',
  TENANT_MISMATCH: 'Ese recurso no pertenece a tu negocio',

  // Membresía
  MEMBRESIA_NO_EXISTE: 'No encontramos esa membresía',
  MEMBRESIA_YA_PAUSADA: 'La membresía ya estaba pausada',
  MEMBRESIA_YA_ACTIVA: 'La membresía ya estaba activa',
  TIER_NO_EXISTE: 'No encontramos ese plan',

  // Reserva
  RESERVA_NO_EXISTE: 'No encontramos esa reserva',
  RESERVA_YA_CANCELADA: 'Esta reserva ya estaba cancelada',
  RESERVA_NO_CANCELABLE: 'Esta reserva ya no se puede cancelar',

  // Check-in
  YA_CHECK_IN: 'Este miembro ya hizo check-in',
  CHECK_IN_NO_EXISTE: 'No encontramos ese check-in',
  CHECK_IN_NO_REVERTIBLE: 'Este check-in ya no se puede revertir',

  // Socio
  SOCIO_NO_EXISTE: 'No encontramos ese socio',
  SOCIO_YA_BLOQUEADO: 'El socio ya estaba bloqueado',
  SOCIO_NO_BLOQUEADO: 'El socio no estaba bloqueado',

  // Motivo (validación)
  MOTIVO_REQUERIDO: 'El motivo es obligatorio para esta acción',
};

const FALLBACK = 'No pudimos completar la acción. Reintentá en unos segundos';

function extractMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

/** Extrae el CÓDIGO (entidad_verbo en MAYÚSCULAS) del mensaje del RPC. */
function extractCode(message: string): string | null {
  // Preferimos el código al inicio: "NO_AUTORIZADO: mensaje".
  const atStart = message.match(/^\s*([A-Z][A-Z0-9_]{2,}):/);
  if (atStart) return atStart[1];
  // Si no, buscamos un token tipo WORD_WORD en mayúsculas en cualquier lado
  // (Postgres a veces antepone su propio prefijo al mensaje del RAISE).
  const anywhere = message.match(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/);
  return anywhere ? anywhere[1] : null;
}

export function translateActionError(error: unknown): string {
  const message = extractMessage(error);
  const code = extractCode(message);

  if (code && ERROR_CODE_MAP[code]) return ERROR_CODE_MAP[code];

  // Sin match: devolvemos el mensaje sin el prefijo "CODIGO:" si lo tenía.
  const stripped = message.replace(/^\s*[A-Z][A-Z0-9_]{2,}:\s*/, '').trim();
  if (stripped) return stripped;

  return FALLBACK;
}
