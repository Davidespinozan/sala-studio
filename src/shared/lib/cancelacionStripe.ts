import { backendPost } from './backend';

/**
 * Llama a `cancelacion-stripe` (BLOCK 2) — programa o retira una cancelación
 * Stripe diferida. Un solo wrapper para socio (sobre sí mismo) y recepción
 * (sobre otro, con motivo). La autorización real vive en el backend
 * (iniciar_operacion_cancelacion); esto solo tipa la llamada.
 */
export interface ResultadoCancelacionStripe {
  ok: boolean;
  operacion_id?: string;
  estado?: 'aplicado' | 'procesando' | 'sin_efecto_membresia_terminal';
  resultado?: { aplicado?: boolean; period_end_fresco?: string | null } | null;
  reason?: string;
}

export async function llamarCancelacionStripe(args: {
  usuarioId: string;
  accion: 'programar' | 'retirar';
  motivo?: string;
  operacionId?: string;
}): Promise<ResultadoCancelacionStripe> {
  return backendPost<ResultadoCancelacionStripe>('cancelacion-stripe', {
    usuario_id: args.usuarioId,
    accion: args.accion,
    motivo: args.motivo,
    operacion_id: args.operacionId
  });
}

/**
 * Traductor mínimo para el self-serve del socio (Perfil.tsx) — vive fuera de
 * @reception, que no es importable desde @member. Recepción usa su propio
 * traducirErrorAccion.ts (ya tiene estos mismos códigos agregados).
 */
const CODIGOS: Record<string, string> = {
  MEMBRESIA_SIN_STRIPE: 'Tu plan no tiene una suscripción de Stripe',
  MEMBRESIA_TERMINAL: 'Tu plan ya está cerrado',
  SIN_CANCELACION_PENDIENTE: 'No tenés ninguna cancelación programada para retirar',
  CANCELACION_YA_PENDIENTE: 'Ya hay una cancelación programada',
  NO_AUTORIZADO: 'No tenés permiso para esta acción',
  TENANT_MISMATCH: 'Ese recurso no pertenece a tu negocio'
};

export function traducirErrorCancelacion(error: unknown): string {
  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string'
        ? ((error as { message: string }).message)
        : '';
  const match = message.match(/^\s*([A-Z][A-Z0-9_]{2,}):/);
  const code = match?.[1];
  if (code && CODIGOS[code]) return CODIGOS[code];
  const stripped = message.replace(/^\s*[A-Z][A-Z0-9_]{2,}:\s*/, '').trim();
  return stripped || 'No pudimos completar la acción. Probá de nuevo en unos segundos';
}
