import { describe, it, expect } from 'vitest';
import { porCobrarAutoservicioActivo, conPorCobrarAutoservicio, autoservicioActivo } from '../cobrosConfig';

// The Core (22-oct-2026): "Pagar en recepción" activa el plan y queda por cobrar.
describe('cobrosConfig · por_cobrar_autoservicio', () => {
  it('default FALSE; solo true explícito', () => {
    expect(porCobrarAutoservicioActivo(null)).toBe(false);
    expect(porCobrarAutoservicioActivo({ cobros: { autoservicio: true } })).toBe(false);
    expect(porCobrarAutoservicioActivo({ cobros: { por_cobrar_autoservicio: 'true' } })).toBe(false);
    expect(porCobrarAutoservicioActivo({ cobros: { por_cobrar_autoservicio: true } })).toBe(true);
  });
  it('no pisa autoservicio ni el resto del config', () => {
    const next = conPorCobrarAutoservicio({ cobros: { autoservicio: false }, registro: { acceso_sin_plan: true } }, true);
    expect(next).toEqual({ cobros: { autoservicio: false, por_cobrar_autoservicio: true }, registro: { acceso_sin_plan: true } });
    expect(autoservicioActivo(next)).toBe(false);
  });
});
