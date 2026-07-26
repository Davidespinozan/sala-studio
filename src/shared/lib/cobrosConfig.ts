// ============================================================================
// AUTOSERVICIO DE PAGOS DEL SOCIO (por gym)
// ----------------------------------------------------------------------------
// Vive en `tenants.config.cobros.autoservicio`. Responde: ¿el socio puede PAGAR
// por su cuenta (membresía desde la app / desde la landing), o el gym cobra
// 100% en recepción?
//
// Default TRUE: casi todos los gyms venden en autoservicio; solo quien lo apaga
// a propósito (numa: cobra todo en el mostrador, la app es solo para reservar)
// queda en modo "solo recepción". Apagarlo NO impide crear cuenta ni reservar;
// solo esconde las superficies de COBRO (checkout, cambiar plan, método de pago)
// y deja el camino "coordiná el pago con el gym".
// ============================================================================

/** ¿El gym vende en autoservicio (el socio paga solo)? Default TRUE; solo un
 *  `false` explícito lo apaga. */
export function autoservicioActivo(config: Record<string, unknown> | null | undefined): boolean {
  const cobros = (config?.cobros ?? {}) as Record<string, unknown>;
  return cobros.autoservicio !== false;
}

/** Devuelve el config con el autoservicio prendido/apagado, sin pisar el resto
 *  (misma trampa del jsonb compartido que en `conModulo`/`conVentaSocio`). */
export function conAutoservicio(
  config: Record<string, unknown> | null | undefined,
  activo: boolean
): Record<string, unknown> {
  const base = config ?? {};
  const cobros = { ...((base.cobros ?? {}) as Record<string, unknown>), autoservicio: activo };
  return { ...base, cobros };
}