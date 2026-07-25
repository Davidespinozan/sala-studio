// ============================================================================
// AJUSTES DE LA TIENDA (sub-config del complemento, por gym)
// ----------------------------------------------------------------------------
// Vive en `tenants.config.tienda`, junto al resto de la config del gym. Son
// ajustes DENTRO del módulo tienda (no otro módulo). El primero: si los socios
// pueden comprar desde su app.
//
// numa lo deja apagado (no quiere venta desde la app); un padel lo prende (el
// socio compra desde la cancha con su tarjeta guardada). Lo maneja el admin.
// ============================================================================

/** ¿Los socios pueden comprar desde su app? Default: NO (se prende a propósito). */
export function ventaSocioActiva(config: Record<string, unknown> | null | undefined): boolean {
  const tienda = (config?.tienda ?? {}) as Record<string, unknown>;
  return tienda.venta_socio === true;
}

/** Devuelve el config con la venta-a-socio prendida o apagada, sin pisar el
 *  resto (misma trampa del jsonb compartido que en `conModulo`). */
export function conVentaSocio(
  config: Record<string, unknown> | null | undefined,
  activo: boolean
): Record<string, unknown> {
  const base = config ?? {};
  const tienda = { ...((base.tienda ?? {}) as Record<string, unknown>), venta_socio: activo };
  return { ...base, tienda };
}