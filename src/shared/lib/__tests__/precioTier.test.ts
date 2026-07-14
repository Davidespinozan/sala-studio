import { describe, it, expect } from 'vitest';
import { formatearPrecioTier, sufijoPeriodoTier } from '../precioTier';

/**
 * El signup formateaba el precio a mano, con '$' y '/mes' clavados. Un plan anual
 * de $12.000 se le anunciaba al socio como "$12,000/mes" — trece veces más caro
 * de lo que es. Y un gym que no cobra en pesos mexicanos veía el símbolo de otro
 * país. Ahora la landing y el signup usan esto mismo, así que no pueden divergir.
 */

const tier = (tipo: string, periodo: string, clases: number | null = null) => ({
  tipo,
  periodo,
  clases_incluidas: clases
});

describe('sufijoPeriodoTier', () => {
  it('un plan anual NO dice "/mes"', () => {
    expect(sufijoPeriodoTier(tier('tiempo', 'anual'))).toBe('/año');
  });

  it('un plan quincenal se cobra cada quincena', () => {
    expect(sufijoPeriodoTier(tier('tiempo', 'quincenal'))).toBe('/quincena');
  });

  it('un plan mensual sí dice "/mes"', () => {
    expect(sufijoPeriodoTier(tier('tiempo', 'mensual'))).toBe('/mes');
  });

  it('un paquete no se cobra por periodo: se compra una vez', () => {
    expect(sufijoPeriodoTier(tier('creditos', 'mensual', 10))).toBe(' · 10 clases');
    expect(sufijoPeriodoTier(tier('hibrido', 'mensual', 8))).toBe(' · 8 clases');
  });

  it('un paquete sin clases cargadas no rompe', () => {
    expect(sufijoPeriodoTier(tier('creditos', 'mensual', null))).toBe(' · 0 clases');
  });
});

describe('formatearPrecioTier', () => {
  it('usa la moneda DEL GYM, no pesos mexicanos siempre', () => {
    // En locale es-MX el euro se rotula "EUR" y el dólar de EE.UU. "USD": lo que
    // importa es que NO se muestre un "$" a secas, que el socio leería como pesos.
    expect(formatearPrecioTier(150000, 'eur')).toContain('EUR');
    expect(formatearPrecioTier(150000, 'usd')).toContain('1,500');
  });

  it('no muestra centavos: los precios de gimnasio son redondos', () => {
    expect(formatearPrecioTier(120050, 'mxn')).not.toContain('.50');
  });

  it('una moneda inválida no rompe la pantalla de conversión', () => {
    expect(formatearPrecioTier(50000, 'no-existe')).toBe('$500');
  });

  it('sin moneda cae a MXN', () => {
    expect(formatearPrecioTier(50000, '')).toContain('500');
  });
});
