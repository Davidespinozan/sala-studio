import { describe, it, expect } from 'vitest';
import { accesoSinPlanActivo, conAccesoSinPlan, altaSinPlanActiva, conAltaSinPlan } from '../registroConfig';

// The Core (17-oct-2026): entrar a la app sin plan activo. Default apagado; el
// flag no pisa el resto de config.registro (pide_salud, permite_sin_plan).
describe('registroConfig · acceso_sin_plan', () => {
  it('default FALSE (sin config, registro vacío, valor no booleano)', () => {
    expect(accesoSinPlanActivo(null)).toBe(false);
    expect(accesoSinPlanActivo({})).toBe(false);
    expect(accesoSinPlanActivo({ registro: {} })).toBe(false);
    expect(accesoSinPlanActivo({ registro: { acceso_sin_plan: 'true' } })).toBe(false);
  });
  it('solo true explícito lo prende', () => {
    expect(accesoSinPlanActivo({ registro: { acceso_sin_plan: true } })).toBe(true);
  });
  it('conAccesoSinPlan no pisa pide_salud ni permite_sin_plan ni el resto del config', () => {
    const base = { cobros: { autoservicio: true }, registro: { pide_salud: true, permite_sin_plan: true } };
    const next = conAccesoSinPlan(base, true);
    expect(next).toEqual({ cobros: { autoservicio: true }, registro: { pide_salud: true, permite_sin_plan: true, acceso_sin_plan: true } });
    expect(altaSinPlanActiva(next)).toBe(true);
    expect(accesoSinPlanActivo(conAccesoSinPlan(next, false))).toBe(false);
    // y al revés: prender alta sin plan no borra acceso_sin_plan
    expect(accesoSinPlanActivo(conAltaSinPlan(next, false))).toBe(true);
  });
});
