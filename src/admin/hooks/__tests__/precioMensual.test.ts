import { describe, it, expect } from 'vitest';
import { precioMensual } from '../useReportesEconomia';

/**
 * El MRR compara planes con periodicidades distintas, así que todos se
 * normalizan a mensual. Un error acá no rompe nada visible: simplemente el gym
 * ve un ingreso que no es el suyo, y toma decisiones con un número falso.
 */

const tier = (periodo: string, precio: number) => ({
  slug: 'x',
  nombre: 'X',
  precio_centavos: precio,
  moneda: 'MXN',
  periodo
});

describe('precioMensual', () => {
  it('un plan mensual vale lo que dice', () => {
    expect(precioMensual(tier('mensual', 100000))).toBe(100000);
  });

  it('un plan QUINCENAL vale el doble al mes (se cobra dos veces)', () => {
    // El bug original: contaba $600 cuando el gym factura $1.200 al mes.
    expect(precioMensual(tier('quincenal', 60000))).toBe(120000);
  });

  it('un plan anual se reparte entre 12', () => {
    expect(precioMensual(tier('anual', 1200000))).toBe(100000);
  });

  it('un periodo desconocido se toma como mensual (no rompe el reporte)', () => {
    expect(precioMensual(tier('vitalicio', 50000))).toBe(50000);
  });
});
