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
