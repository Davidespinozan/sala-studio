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
 * Lo que va DESPUÉS del precio: "/mes", "/año", "/quincena", o las clases que
 * trae el paquete. Un paquete no se cobra por periodo: se compra una vez.
 */
export function sufijoPeriodoTier(tier: {
  tipo: string | null;
  periodo: string | null;
  clases_incluidas: number | null;
}): string {
  if (tier.tipo === 'creditos' || tier.tipo === 'hibrido') {
    return ` · ${tier.clases_incluidas ?? 0} clases`;
  }
  if (tier.periodo === 'anual') return '/año';
  if (tier.periodo === 'quincenal') return '/quincena';
  return '/mes';
}
