// ============================================================================
// SOCIO "SIN CORREO" — marcador de un socio importado que no tiene email real.
// ----------------------------------------------------------------------------
// Al importar (SIAGYM y otros), los socios sin email traen uno de relleno
// (default@siagym.com). No se guarda el falso: se les pone un marcador único
// `…@sin-correo.local`. Cuando vengan al local, recepción les pone su email real
// y ahí activan su cuenta. Estos helpers detectan y muestran ese estado.
// ============================================================================

const DOMINIO_MARCADOR = '@sin-correo.local';

/** true si el email es un marcador (socio importado sin correo real). */
export function esCorreoMarcador(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(DOMINIO_MARCADOR);
}

/** Para mostrar: el email real, o "Sin correo" si es un marcador. */
export function etiquetaCorreo(email: string | null | undefined): string {
  if (!email) return 'Sin correo';
  return esCorreoMarcador(email) ? 'Sin correo' : email;
}
