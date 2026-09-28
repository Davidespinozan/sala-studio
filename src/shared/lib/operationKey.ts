// Idempotencia de operaciones de dinero (Wave 1, RC-01).
// ─────────────────────────────────────────────────────────────────────────────
// Una operation_key = UNA intención de negocio (una venta, un cobro, un
// reembolso, un alta/renovación de plan). El backend (RPC + tabla
// business_operations) usa esta key para que un reintento —tras timeout, pérdida
// de respuesta o doble clic— NO ejecute el efecto dos veces, sino que converja al
// resultado original.
//
// Regla del lifecycle en el cliente:
//   • se MANTIENE estable entre reintentos con la MISMA entrada;
//   • se REGENERA cuando cambia cualquier entrada material (así un reintento ya
//     corregido no choca contra el backend como IDEMPOTENCY_CONFLICT);
//   • al cerrar/remontar el modal (o vaciar el carrito) nace una nueva.
// NO se genera una key nueva en cada submit: se genera una vez y sobrevive al
// reintento. NO se manda como header global (el fetch de supabase inyecta
// x-tenant-id a nivel proceso); va SIEMPRE como parámetro p_operation_key.

import { useEffect, useRef, useState } from 'react';

/**
 * Devuelve una UUID de idempotencia estable para una intención de negocio.
 * Pásale las entradas materiales de la operación: mientras no cambien, la key
 * se conserva (los reintentos convergen); si cambian, se genera una nueva.
 */
export function useOperationKey(inputs: ReadonlyArray<unknown>): string {
  const [key, setKey] = useState<string>(() => crypto.randomUUID());
  const primeraVez = useRef(true);
  useEffect(() => {
    // En el montaje conservamos la key inicial; solo regeneramos cuando las
    // entradas cambian DESPUÉS del montaje.
    if (primeraVez.current) {
      primeraVez.current = false;
      return;
    }
    setKey(crypto.randomUUID());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, inputs);
  return key;
}

/** Genera una operation_key suelta (para flujos sin hook / imperativos). */
export function nuevaOperationKey(): string {
  return crypto.randomUUID();
}

/** ¿El error de una RPC de dinero es un conflicto de idempotencia? */
export function esConflictoIdempotencia(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.includes('IDEMPOTENCY_CONFLICT');
}

/** Mensaje neutro para el operador cuando ocurre un IDEMPOTENCY_CONFLICT. */
export const MSG_CONFLICTO_IDEMPOTENCIA =
  'Esta operación ya se registró con datos distintos. Refresca y verifica antes de reintentar.';
