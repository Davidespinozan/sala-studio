import { describe, it, expect } from 'vitest';
import { precioMensual } from '../useReportesEconomia';

/**
 * El MRR compara planes de distinta duración, así que todos se normalizan a
 * mensual (30 días) por `duracion_dias`. Un error acá no rompe nada visible: el
 * gym ve un ingreso que no es el suyo y decide con un número falso.
 */
const tier = (o: Partial<Parameters<typeof precioMensual>[0]>) => ({
  slug: 'x',
  nombre: 'X',
  precio_centavos: 0,
  moneda: 'MXN',
  periodo: 'mensual',
  duracion_dias: null,
  pago_unico: false,
  ...o
});

describe('precioMensual', () => {
  it('30 días vale lo que dice', () => {
    expect(precioMensual(tier({ precio_centavos: 100000, duracion_dias: 30 }))).toBe(100000);
  });

  it('quincenal (15 días) vale el doble al mes', () => {
    expect(precioMensual(tier({ precio_centavos: 60000, duracion_dias: 15 }))).toBe(120000);
  });

  it('90 días se reparte: preventa $3.000 → $1.000/mes', () => {
    expect(precioMensual(tier({ precio_centavos: 300000, duracion_dias: 90 }))).toBe(100000);
  });

  it('un pase de PAGO ÚNICO no cuenta como ingreso recurrente', () => {
    expect(precioMensual(tier({ precio_centavos: 60000, duracion_dias: 7, pago_unico: true }))).toBe(0);
  });

  it('fallback por periodo si el tier no tiene duracion_dias (anual → /12)', () => {
    expect(precioMensual(tier({ precio_centavos: 1200000, duracion_dias: null, periodo: 'anual' }))).toBe(100000);
  });
});
