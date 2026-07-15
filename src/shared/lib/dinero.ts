/**
 * Formatea centavos a moneda. Un solo lugar para que Caja, el Dashboard y los
 * reportes muestren el dinero igual. Sin decimales: en un gym nadie piensa en
 * centavos, y $1,200 se lee más rápido que $1,200.00.
 */
export function formatearMoneda(centavos: number, moneda = 'MXN'): string {
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: (moneda || 'MXN').toUpperCase(),
      maximumFractionDigits: 0,
    }).format(centavos / 100);
  } catch {
    // Moneda desconocida para Intl: al menos mostramos el monto.
    return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
  }
}
