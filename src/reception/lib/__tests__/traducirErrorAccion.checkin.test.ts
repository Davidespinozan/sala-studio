import { describe, it, expect } from 'vitest';
import { translateActionError } from '../traducirErrorAccion';

// La ventana del check-in manual (check_in_manual_atomic) lanzaba un texto crudo
// con la hora en la zona del servidor (UTC): "abre 30 min antes (a las 23:00)".
describe('translateActionError · ventana de check-in', () => {
  it('DEMASIADO_TEMPRANO no muestra la hora del servidor', () => {
    const msg = translateActionError({ message: 'DEMASIADO_TEMPRANO: El check-in manual abre 30 min antes (a las 23:00)' });
    expect(msg).not.toContain('23:00');
    expect(msg).toMatch(/todavía no abre/);
  });
  it('DEMASIADO_TARDE', () => {
    expect(translateActionError('DEMASIADO_TARDE: El check-in manual cerró a las 01:30')).toBe('El check-in de esta clase ya cerró');
  });
  it('estados de la reserva que impiden el check-in', () => {
    expect(translateActionError('RESERVA_CANCELADA: Reserva cancelada')).toMatch(/cancelada/);
    expect(translateActionError('RESERVA_NO_SHOW: Reserva marcada como inasistencia')).toMatch(/inasistencia/);
  });
});
