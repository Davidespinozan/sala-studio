import { describe, it, expect } from 'vitest';
import {
  validarEmail,
  validarNuevaContrasena,
  traducirErrorRecuperacion
} from '../recuperacionLogic';

// ============================================================================
// validarEmail — pantalla "Recuperar contraseña"
// ============================================================================

describe('validarEmail (recuperar)', () => {
  it('acepta emails válidos', () => {
    expect(validarEmail('ana@gym.com').ok).toBe(true);
    expect(validarEmail('a.b+c@dominio.mx').ok).toBe(true);
  });
  it('rechaza vacío', () => {
    expect(validarEmail('').ok).toBe(false);
    expect(validarEmail('   ').ok).toBe(false);
  });
  it('rechaza formatos inválidos', () => {
    expect(validarEmail('ana').ok).toBe(false);
    expect(validarEmail('ana@').ok).toBe(false);
    expect(validarEmail('ana@dominio').ok).toBe(false);
  });
});

// ============================================================================
// validarNuevaContrasena — fuerza + coincidencia
// ============================================================================

describe('validarNuevaContrasena', () => {
  it('acepta una contraseña fuerte que coincide', () => {
    expect(validarNuevaContrasena('segura123', 'segura123').ok).toBe(true);
  });

  it('rechaza cuando no coinciden', () => {
    const r = validarNuevaContrasena('segura123', 'segura124');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no coinciden/i);
  });

  it('rechaza contraseña corta (< 8) aunque coincida', () => {
    expect(validarNuevaContrasena('abc12', 'abc12').ok).toBe(false);
  });

  it('rechaza sin letra', () => {
    expect(validarNuevaContrasena('12345678', '12345678').ok).toBe(false);
  });

  it('rechaza sin número', () => {
    expect(validarNuevaContrasena('sololetras', 'sololetras').ok).toBe(false);
  });

  it('prioriza el error de fuerza sobre el de coincidencia', () => {
    // débil Y distinta → primero avisa de la fuerza
    const r = validarNuevaContrasena('corta', 'otra');
    expect(r.ok).toBe(false);
    expect(r.error).not.toMatch(/no coinciden/i);
  });
});

// ============================================================================
// traducirErrorRecuperacion
// ============================================================================

describe('traducirErrorRecuperacion', () => {
  it('mapea enlace expirado a un mensaje claro', () => {
    expect(traducirErrorRecuperacion('Email link is invalid or has expired')).toMatch(
      /expiró o no es válido/i
    );
  });
  it('mapea token inválido', () => {
    expect(traducirErrorRecuperacion('Invalid token')).toMatch(/expiró o no es válido/i);
  });
  it('mapea sesión faltante (enlace ya usado/caduco)', () => {
    expect(traducirErrorRecuperacion('Auth session missing!')).toMatch(
      /expiró o no es válido/i
    );
  });
  it('mapea "contraseña igual a la anterior"', () => {
    expect(
      traducirErrorRecuperacion('New password should be different from the old password')
    ).toMatch(/distinta de la anterior/i);
  });
  it('mapea rate limit', () => {
    expect(traducirErrorRecuperacion('Too many requests')).toMatch(/demasiados intentos/i);
  });
  it('un mensaje desconocido cae a un genérico en español (no expone el crudo)', () => {
    expect(traducirErrorRecuperacion('Some raw english error')).toMatch(/no pudimos completar/i);
  });
});
