// ============================================================================
// Status de cuenta que significan "acceso retirado".
// ----------------------------------------------------------------------------
// Un usuario en cualquiera de estos status NO puede operar, sin importar su rol.
// Los guards (admin/recepción/miembro) lo ejectan con signOut. NO incluye
// 'pendiente_onboarding' ni 'pendiente_pago': esos son estados transitorios en
// los que el usuario sí debe poder avanzar (onboarding del owner, pantalla de
// pendiente del miembro).
// ============================================================================

export const STATUS_SIN_ACCESO = ['revocado', 'suspendido', 'cancelado'] as const;

/** true si el status implica acceso retirado (revocado/suspendido/cancelado). */
export function accesoRevocado(status: string | null | undefined): boolean {
  return !!status && (STATUS_SIN_ACCESO as readonly string[]).includes(status);
}
