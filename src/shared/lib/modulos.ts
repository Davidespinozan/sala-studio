// ============================================================================
// MÓDULOS ACTIVABLES POR GYM (complementos)
// ----------------------------------------------------------------------------
// Un complemento es una utilidad que el gym contrata APARTE del plan: la Tienda
// es el primero. El plan escala por cantidad de socios; un complemento es
// ortogonal a eso (un gym chico puede vender muchísimo y uno grande nada), así
// que NO se mete en un tier — se prende por gym, con su propio cobro.
//
// ESTO ES EL MECANISMO, NO EL CASO PUNTUAL. Cada complemento futuro entra
// agregando una entrada a MODULOS; el resto del andamiaje (menú con candado,
// puerta "¿módulo o página de venta?", cobro como renglón aparte) ya está.
// Sirve además para gatear features por plan el día que haga falta.
//
// El estado vive en `tenants.config.modulos` (jsonb), junto a los otros flags
// del tenant (tema, reglas, landing…). Un complemento no contratado está
// APAGADO por default: la ausencia de la marca es "no lo tiene".
//
// EL PRECIO NO VIVE ACÁ. El complemento tiene UN precio estándar y el gym lo
// paga solo desde el admin (self-serve, sin negociar con nadie); al pagar, el
// webhook prende la marca. El módulo solo sabe si está prendido o no.
// ============================================================================

export type Modulo = 'tienda';

export interface ModuloInfo {
  id: Modulo;
  nombre: string;
  /** Qué gana el gym con esto. Es el texto de la página de venta del candado. */
  gancho: string;
}

export const MODULOS: Record<Modulo, ModuloInfo> = {
  tienda: {
    id: 'tienda',
    nombre: 'Tienda',
    gancho: 'Vendé productos —agua, proteína, ropa— desde recepción y desde la app, con el stock y el corte de caja resueltos.'
  }
};

/**
 * ¿El gym tiene este complemento activo?
 * Se lee de `config.modulos.<id> === true`. Cualquier otra cosa (ausente, false,
 * basura) es NO: un complemento se prende explícitamente, nunca por accidente.
 */
export function moduloActivo(
  config: Record<string, unknown> | null | undefined,
  id: Modulo
): boolean {
  const modulos = (config?.modulos ?? {}) as Record<string, unknown>;
  return modulos[id] === true;
}

/**
 * Devuelve el `config` con un módulo prendido o apagado, sin pisar el resto.
 * No escribe en la base — solo arma el objeto; el guardado lo hace quien lo use
 * (el webhook al confirmarse el cobro, o un admin de SALA). Preserva todo lo
 * demás del config, que es la trampa clásica al tocar un jsonb compartido.
 */
export function conModulo(
  config: Record<string, unknown> | null | undefined,
  id: Modulo,
  activo: boolean
): Record<string, unknown> {
  const base = config ?? {};
  const modulos = { ...((base.modulos ?? {}) as Record<string, unknown>), [id]: activo };
  return { ...base, modulos };
}