/**
 * Lógica pura del alcance por sede del socio. Sin React, sin Supabase. Testeable.
 * Es la fuente de verdad que usa MemberSucursalProvider para decidir qué sedes
 * ve y usa el socio según el alcance de su plan (Fase 6 multi-sucursal).
 */

/** Subconjunto de la membresía que define el alcance (lo que devuelve useMembresiaActual). */
export interface AlcanceMembresia {
  /** El plan da acceso a todas las sedes (true) o solo a la suscrita (false). */
  tier_acceso_todas_sucursales: boolean;
  /** Sede a la que se suscribió la membresía (null = sin sede definida). */
  sucursal_id: string | null;
}

/**
 * Sedes que el socio puede ver y usar según el alcance de su plan.
 *
 * Reglas (en orden):
 *  - Sin membresía (null)               → TODAS (no se restringe sin datos del plan).
 *  - Plan con acceso a todas las sedes  → TODAS.
 *  - Plan de una sede SIN sede definida → TODAS (no se puede restringir sin saber cuál).
 *  - Plan de una sede CON sede definida → solo esa (si está en la lista; si no, ninguna).
 *
 * No muta la lista de entrada.
 */
export function sucursalesVisibles<T extends { id: string }>(
  sucursales: T[],
  alcance: AlcanceMembresia | null
): T[] {
  const todasSedes = alcance?.tier_acceso_todas_sucursales ?? true;
  const memSucursal = alcance?.sucursal_id ?? null;
  if (todasSedes || !memSucursal) return sucursales;
  return sucursales.filter((s) => s.id === memSucursal);
}

/**
 * Resuelve la sede activa "segura": respeta la elegida si sigue siendo visible
 * (dentro del alcance del plan); si no, cae a la primera visible, o null si no
 * hay ninguna. Evita que una elección vieja o fuera del plan quede activa.
 */
export function resolverSucursalActiva<T extends { id: string }>(
  visibles: T[],
  elegidaId: string | null
): string | null {
  if (elegidaId && visibles.some((s) => s.id === elegidaId)) return elegidaId;
  return visibles[0]?.id ?? null;
}
