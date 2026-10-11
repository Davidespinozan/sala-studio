import { describe, expect, it } from 'vitest';
import { traducirErrorDescuento, venceSugerido } from '../descuentos';

describe('venceSugerido', () => {
  it('suma meses de calendario', () => {
    expect(venceSugerido('2026-10-11', 6)).toBe('2027-04-11');
    expect(venceSugerido('2026-01-15', 1)).toBe('2026-02-15');
  });

  it('recorta al fin de mes cuando el día no existe', () => {
    // 31-ago + 6 meses = "31-feb" → 28-feb (no se desborda a marzo).
    expect(venceSugerido('2026-08-31', 6)).toBe('2027-02-28');
    expect(venceSugerido('2027-08-31', 6)).toBe('2028-02-29'); // bisiesto
    expect(venceSugerido('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('cruza de año', () => {
    expect(venceSugerido('2026-12-01', 2)).toBe('2027-02-01');
  });
});

describe('traducirErrorDescuento', () => {
  it('no expone el código técnico', () => {
    expect(traducirErrorDescuento('NO_AUTORIZADO: Solo recepción…')).not.toContain('NO_AUTORIZADO');
    expect(traducirErrorDescuento('FECHA_INVALIDA: x')).toContain('fecha');
    expect(traducirErrorDescuento('duplicate key value violates unique constraint "descuentos_tenant_nombre_uniq"'))
      .toContain('ese nombre');
    expect(traducirErrorDescuento('boom')).toContain('Prueba de nuevo');
  });
});
