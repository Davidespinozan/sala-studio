import { describe, it, expect } from 'vitest';
import { accesoRevocado, STATUS_SIN_ACCESO } from '../accountStatus';

// Guard de #9: estos status deslogean en useAdminGuard/ReceptionLayout. Un
// cambio acá silenciosamente dejaría entrar (o expulsaría de más) a usuarios.
describe('accesoRevocado', () => {
  it('es true para los status de acceso retirado', () => {
    expect(accesoRevocado('revocado')).toBe(true);
    expect(accesoRevocado('suspendido')).toBe(true);
    expect(accesoRevocado('cancelado')).toBe(true);
  });

  it('es false para status operables o transitorios', () => {
    // 'activo' y 'pendiente_pago' operan; 'pendiente_onboarding' debe poder
    // avanzar (owner en onboarding) — NO se expulsa.
    expect(accesoRevocado('activo')).toBe(false);
    expect(accesoRevocado('pendiente_pago')).toBe(false);
    expect(accesoRevocado('pendiente_onboarding')).toBe(false);
  });

  it('es false para null/undefined/vacío (no expulsa por falta de dato)', () => {
    expect(accesoRevocado(null)).toBe(false);
    expect(accesoRevocado(undefined)).toBe(false);
    expect(accesoRevocado('')).toBe(false);
  });

  it('STATUS_SIN_ACCESO es exactamente revocado/suspendido/cancelado', () => {
    expect([...STATUS_SIN_ACCESO].sort()).toEqual(['cancelado', 'revocado', 'suspendido']);
  });
});
