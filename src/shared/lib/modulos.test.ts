import { describe, it, expect } from 'vitest';
import { moduloActivo, conModulo } from './modulos';

describe('moduloActivo', () => {
  it('está prendido solo con true explícito', () => {
    expect(moduloActivo({ modulos: { tienda: true } }, 'tienda')).toBe(true);
  });

  it('cualquier otra cosa es NO: un complemento no se prende por accidente', () => {
    // Ausente, false, o basura → apagado. Un complemento pago se prende
    // explícitamente al pagarlo, nunca por un valor raro en el jsonb.
    expect(moduloActivo({}, 'tienda')).toBe(false);
    expect(moduloActivo(null, 'tienda')).toBe(false);
    expect(moduloActivo({ modulos: {} }, 'tienda')).toBe(false);
    expect(moduloActivo({ modulos: { tienda: false } }, 'tienda')).toBe(false);
    expect(moduloActivo({ modulos: { tienda: 'sí' } }, 'tienda')).toBe(false);
    expect(moduloActivo({ modulos: null }, 'tienda')).toBe(false);
  });
});

describe('conModulo', () => {
  it('prende el módulo sin pisar el resto del config', () => {
    // La trampa clásica al tocar un jsonb compartido: sobrescribir todo el
    // objeto y borrar timezone/tema/reglas. Esto tiene que preservarlo.
    const config = { timezone: 'America/Mazatlan', tema: 'oscuro', modulos: { otro: true } };
    const next = conModulo(config, 'tienda', true);

    expect(next.timezone).toBe('America/Mazatlan');
    expect(next.tema).toBe('oscuro');
    expect(next.modulos).toEqual({ otro: true, tienda: true });
  });

  it('apaga el módulo dejando los otros módulos intactos', () => {
    const config = { modulos: { tienda: true, otro: true } };
    const next = conModulo(config, 'tienda', false);
    expect(next.modulos).toEqual({ tienda: false, otro: true });
  });

  it('funciona con config vacío o nulo', () => {
    expect(conModulo(null, 'tienda', true)).toEqual({ modulos: { tienda: true } });
    expect(conModulo({}, 'tienda', true)).toEqual({ modulos: { tienda: true } });
  });
});