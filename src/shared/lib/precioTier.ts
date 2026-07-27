/**
 * Cómo se muestra el precio de un plan. Vive acá porque la landing y el signup
 * tienen que decir LO MISMO: el signup formateaba a mano con '$' y '/mes' fijos,
 * así que un plan anual de $12.000 se anunciaba como "$12,000/mes" y un gym que
 * no cobra en pesos mexicanos veía el símbolo y el formato equivocados.
 */

/** Precio en la moneda del plan. Cae a un formato simple si la moneda no es válida. */
export function formatearPrecioTier(centavos: number, moneda: string): string {
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: (moneda || 'MXN').toUpperCase(),
      maximumFractionDigits: 0
    }).format(centavos / 100);
  } catch {
    return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
  }
}

/**
 * Lo que va DESPUÉS del precio. Se basa en `duracion_dias` (la fuente de verdad
 * de la vigencia), NO en `periodo` — que con duraciones libres se deriva y
 * mentía (un plan de 90 días mostraba "/mes"). Un paquete no se cobra por
 * periodo (trae N clases); un pase de pago único no es recurrente (" · 1 día"
 * en vez de "/día"). Recurrente → "/frase"; pago único → " · frase".
 */
export function sufijoPeriodoTier(tier: {
  tipo: string | null;
  periodo: string | null;
  clases_incluidas: number | null;
  duracion_dias?: number | null;
  pago_unico?: boolean | null;
}): string {
  if (tier.tipo === 'creditos' || tier.tipo === 'hibrido') {
    return ` · ${tier.clases_incluidas ?? 0} clases`;
  }
  const d = tier.duracion_dias ?? null;
  const frase =
    d === 1 ? '1 día' :
    d === 7 ? '1 semana' :
    d === 15 ? 'quincena' :
    d === 30 ? 'mes' :
    d === 60 ? '2 meses' :
    d === 90 ? '3 meses' :
    d === 365 ? 'año' :
    d != null && d > 0 ? `${d} días` :
    // Fallback (tiers viejos sin duracion_dias): por periodo.
    (tier.periodo === 'anual' ? 'año' : tier.periodo === 'quincenal' ? 'quincena' : 'mes');
  return tier.pago_unico ? ` · ${frase}` : `/${frase}`;
}
