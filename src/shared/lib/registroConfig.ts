// ============================================================================
// REGISTRO DEL SOCIO (por gym) — vive en `tenants.config.registro`
// ----------------------------------------------------------------------------
// ¿El gym permite CREAR CUENTA SIN elegir plan? (el socio elige/paga después,
// dentro del app). Default FALSE: solo quien lo prende a propósito lo habilita;
// el resto de gyms mantienen el alta con plan obligatorio de siempre.
//
// Mismo molde que cobrosConfig.ts (la "trampa del jsonb compartido"): conX no
// pisa el resto de `config.registro` (p. ej. `pide_salud`).
// ============================================================================

/** ¿El gym permite crear cuenta sin plan? Default FALSE; solo un `true` explícito lo prende. */
export function altaSinPlanActiva(config: Record<string, unknown> | null | undefined): boolean {
  const registro = (config?.registro ?? {}) as Record<string, unknown>;
  return registro.permite_sin_plan === true;
}

/** Devuelve el config con el flag prendido/apagado, sin pisar el resto de `registro`. */
export function conAltaSinPlan(
  config: Record<string, unknown> | null | undefined,
  activo: boolean
): Record<string, unknown> {
  const base = config ?? {};
  const registro = { ...((base.registro ?? {}) as Record<string, unknown>), permite_sin_plan: activo };
  return { ...base, registro };
}

// ----------------------------------------------------------------------------
// ¿La cuenta que todavía NO tiene plan activo (status 'pendiente_pago') puede
// ENTRAR a la app y ver calendario, clases y perfil? Default FALSE: hoy esa
// cuenta se queda en la pantalla "elige/paga tu plan" hasta activarse.
//
// Pedido de The Core (17-oct-2026): que el socio se registre con el paquete
// que quiera SIN que se le exija la tarjeta de inmediato, vea la plataforma, y
// el cobro aparezca cuando intente reservar (o cuando él quiera, desde el
// aviso). Lo que impide ir a clase sin pagar no es esta pantalla: es el RPC de
// reservar (SIN_MEMBRESIA) y el check-in, que no cambian.
// ----------------------------------------------------------------------------

/** ¿La cuenta sin plan activo puede entrar a la app? Default FALSE. */
export function accesoSinPlanActivo(config: Record<string, unknown> | null | undefined): boolean {
  const registro = (config?.registro ?? {}) as Record<string, unknown>;
  return registro.acceso_sin_plan === true;
}

/** Devuelve el config con el flag prendido/apagado, sin pisar el resto de `registro`. */
export function conAccesoSinPlan(
  config: Record<string, unknown> | null | undefined,
  activo: boolean
): Record<string, unknown> {
  const base = config ?? {};
  const registro = { ...((base.registro ?? {}) as Record<string, unknown>), acceso_sin_plan: activo };
  return { ...base, registro };
}
