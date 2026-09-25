import { describe, it, expect } from 'vitest';
import { altaSinPlanActiva, conAltaSinPlan } from './registroConfig';

describe('altaSinPlanActiva', () => {
  it('default FALSE: sin config, sin registro, o sin la llave → apagado', () => {
    // Opt-in: solo quien lo prende a propósito abre el alta sin plan.
    expect(altaSinPlanActiva(null)).toBe(false);
    expect(altaSinPlanActiva(undefined)).toBe(false);
    expect(altaSinPlanActiva({})).toBe(false);
    expect(altaSinPlanActiva({ registro: {} })).toBe(false);
    expect(altaSinPlanActiva({ registro: { permite_sin_plan: false } })).toBe(false);
  });

  it('solo un true explícito lo prende', () => {
    expect(altaSinPlanActiva({ registro: { permite_sin_plan: true } })).toBe(true);
  });

  it('un valor no-booleano no lo prende', () => {
    expect(altaSinPlanActiva({ registro: { permite_sin_plan: 'si' } })).toBe(false);
  });
});

describe('conAltaSinPlan', () => {
  it('setea la llave sin pisar el resto del config ni de registro (respeta pide_salud)', () => {
    const config = { tema: 'oscuro', registro: { pide_salud: true }, cobros: { autoservicio: false } };
    const next = conAltaSinPlan(config, true);
    expect(next).toEqual({
      tema: 'oscuro',
      registro: { pide_salud: true, permite_sin_plan: true },
      cobros: { autoservicio: false }
    });
    // No muta el original.
    expect((config.registro as Record<string, unknown>).permite_sin_plan).toBeUndefined();
  });

  it('crea registro si no existía', () => {
    expect(conAltaSinPlan({}, true)).toEqual({ registro: { permite_sin_plan: true } });
    expect(conAltaSinPlan(null, false)).toEqual({ registro: { permite_sin_plan: false } });
  });

  it('ida y vuelta es consistente con altaSinPlanActiva', () => {
    expect(altaSinPlanActiva(conAltaSinPlan({}, true))).toBe(true);
    expect(altaSinPlanActiva(conAltaSinPlan({}, false))).toBe(false);
  });
});
