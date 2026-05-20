// ════════════════════════════════════════════════════════════════════════════
// S7-mock — SINGLE SOURCE OF TRUTH de los planes del SaaS
// ════════════════════════════════════════════════════════════════════════════
// Los 9 precios (3 tiers × 3 monedas) y los límites por tier son definición
// comercial estática. Viven acá, no en la BD: no son datos por-tenant ni
// editables. La columna suscripciones_saas.precio_centavos guarda el snapshot
// de lo que paga cada tenant.
//
// Cuando llegue Stripe real, cada (tier, moneda) mapeará a un Stripe Price ID;
// ese mapeo se agrega acá mismo.
// ════════════════════════════════════════════════════════════════════════════

export type TierSaas = 'starter' | 'pro' | 'business';
export type MonedaSaas = 'mxn' | 'usd' | 'eur';

export interface PlanSaas {
  tier: TierSaas;
  nombre: string;
  resumen: string;
  /** Límite de miembros activos. null = ilimitado. */
  maxMiembros: number | null;
  /** Precio mensual en unidades enteras de cada moneda (no centavos). */
  precios: Record<MonedaSaas, number>;
  features: string[];
}

/** Días de prueba gratis al suscribirse. */
export const TRIAL_DIAS = 7;

export const PLANES_SAAS: Record<TierSaas, PlanSaas> = {
  starter: {
    tier: 'starter',
    nombre: 'Starter',
    resumen: 'Para arrancar tu gimnasio',
    maxMiembros: 200,
    precios: { mxn: 1900, usd: 129, eur: 119 },
    features: [
      'Hasta 200 miembros',
      'Reservas, agenda y check-in',
      'Reportes esenciales',
      'Soporte por email'
    ]
  },
  pro: {
    tier: 'pro',
    nombre: 'Pro',
    resumen: 'Para gimnasios en crecimiento',
    maxMiembros: 600,
    precios: { mxn: 3900, usd: 279, eur: 269 },
    features: [
      'Hasta 600 miembros',
      'Dominio propio',
      'Reportes avanzados (retención y churn)',
      'Soporte prioritario'
    ]
  },
  business: {
    tier: 'business',
    nombre: 'Business',
    resumen: 'Para cadenas y multi-sede',
    maxMiembros: null,
    precios: { mxn: 7900, usd: 549, eur: 499 },
    features: [
      'Miembros ilimitados',
      'Multi-sucursal',
      'Dominio propio',
      'Soporte dedicado'
    ]
  }
};

/** Orden de presentación de los tiers (de menor a mayor). */
export const TIERS_ORDEN: TierSaas[] = ['starter', 'pro', 'business'];

export interface MonedaInfo {
  codigo: MonedaSaas;
  simbolo: string;
  label: string;
}

export const MONEDAS: MonedaInfo[] = [
  { codigo: 'mxn', simbolo: '$', label: 'MXN' },
  { codigo: 'usd', simbolo: 'US$', label: 'USD' },
  { codigo: 'eur', simbolo: '€', label: 'EUR' }
];

/** Precio en centavos — para guardar en suscripciones_saas.precio_centavos. */
export function precioCentavos(tier: TierSaas, moneda: MonedaSaas): number {
  return PLANES_SAAS[tier].precios[moneda] * 100;
}

/** Formatea un precio en centavos a string legible (ej. "$3,900"). */
export function formatPrecio(centavos: number, moneda: MonedaSaas): string {
  const info = MONEDAS.find((m) => m.codigo === moneda) ?? MONEDAS[0];
  const entero = Math.round(centavos / 100);
  return `${info.simbolo}${entero.toLocaleString('es-MX')}`;
}

/** Límite de miembros del tier. null = ilimitado. */
export function limiteMiembros(tier: TierSaas): number | null {
  return PLANES_SAAS[tier].maxMiembros;
}

// Timezones IANA de México → MXN.
const TZ_MEXICO = new Set([
  'America/Mexico_City',
  'America/Cancun',
  'America/Merida',
  'America/Monterrey',
  'America/Matamoros',
  'America/Mazatlan',
  'America/Chihuahua',
  'America/Ciudad_Juarez',
  'America/Ojinaga',
  'America/Hermosillo',
  'America/Tijuana',
  'America/Bahia_Banderas'
]);

/**
 * Sugiere una moneda según la timezone del tenant. Es solo un default —
 * el admin la cambia manualmente en el checkout.
 */
export function monedaSugerida(timezone: string): MonedaSaas {
  if (TZ_MEXICO.has(timezone)) return 'mxn';
  if (timezone.startsWith('Europe/')) return 'eur';
  return 'usd';
}
