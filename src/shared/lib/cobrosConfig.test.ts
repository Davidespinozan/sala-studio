import { describe, it, expect } from 'vitest';
import { autoservicioActivo, conAutoservicio } from './cobrosConfig';

describe('autoservicioActivo', () => {
  it('default TRUE: sin config, sin cobros, o sin la llave → prendido', () => {
    // Invariante crítica: apagarlo por accidente cortaría las ventas de TODOS
    // los gyms. Solo un `false` explícito lo apaga.
    expect(autoservicioActivo(null)).toBe(true);
    expect(autoservicioActivo(undefined)).toBe(true);
    expect(autoservicioActivo({})).toBe(true);
    expect(autoservicioActivo({ cobros: {} })).toBe(true);
    expect(autoservicioActivo({ cobros: { autoservicio: true } })).toBe(true);
  });

  it('solo un false explícito lo apaga (numa: cobra en recepción)', () => {
    expect(autoservicioActivo({ cobros: { autoservicio: false } })).toBe(false);
  });

  it('un valor no-booleano no cuenta como apagado', () => {
    // Nada raro debería apagarlo por accidente; solo el booleano false.
    expect(autoservicioActivo({ cobros: { autoservicio: 'no' } })).toBe(true);
  });
});

describe('conAutoservicio', () => {
  it('setea la llave sin pisar el resto del config ni de cobros', () => {
    const config = { tema: 'oscuro', cobros: { moneda: 'MXN' }, modulos: { tienda: true } };
    const next = conAutoservicio(config, false);
    expect(next).toEqual({
      tema: 'oscuro',
      cobros: { moneda: 'MXN', autoservicio: false },
      modulos: { tienda: true }
    });
    // No muta el original.
    expect((config.cobros as Record<string, unknown>).autoservicio).toBeUndefined();
  });

  it('crea cobros si no existía', () => {
    expect(conAutoservicio({}, true)).toEqual({ cobros: { autoservicio: true } });
    expect(conAutoservicio(null, false)).toEqual({ cobros: { autoservicio: false } });
  });

  it('ida y vuelta es consistente con autoservicioActivo', () => {
    expect(autoservicioActivo(conAutoservicio({}, false))).toBe(false);
    expect(autoservicioActivo(conAutoservicio({}, true))).toBe(true);
  });
});