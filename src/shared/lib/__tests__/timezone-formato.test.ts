import { describe, it, expect } from 'vitest';
import { sumarDias, diasEntre, fechaEnTz, formatHoraEnTz } from '../timezone';

// Estas funciones estuvieron detrás de los bugs de "hora de Europa" y del corte
// de días en admin/recepción. Los tests fijan el comportamiento correcto.

describe('sumarDias', () => {
  it('suma un día', () => {
    expect(sumarDias('2026-08-05', 1)).toBe('2026-08-06');
  });
  it('cruza fin de mes', () => {
    expect(sumarDias('2026-08-31', 1)).toBe('2026-09-01');
  });
  it('resta cruzando año', () => {
    expect(sumarDias('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('cero no cambia la fecha', () => {
    expect(sumarDias('2026-08-05', 0)).toBe('2026-08-05');
  });
});

describe('diasEntre', () => {
  it('mañana = +1', () => {
    expect(diasEntre('2026-08-05', '2026-08-06')).toBe(1);
  });
  it('ayer = -1', () => {
    expect(diasEntre('2026-08-06', '2026-08-05')).toBe(-1);
  });
  it('mismo día = 0', () => {
    expect(diasEntre('2026-08-05', '2026-08-05')).toBe(0);
  });
  it('cruza el mes', () => {
    expect(diasEntre('2026-08-31', '2026-09-01')).toBe(1);
  });
});

describe('fechaEnTz / formatHoraEnTz — instante → hora de pared del gym', () => {
  it('una clase de 5am en Culiacán se lee 05:00 (12:00 UTC, UTC−7)', () => {
    const inst = new Date('2026-08-06T12:00:00Z');
    expect(fechaEnTz(inst, 'America/Mazatlan')).toBe('2026-08-06');
    expect(formatHoraEnTz(inst, 'America/Mazatlan')).toBe('05:00');
  });

  it('un instante de madrugada UTC cae el día ANTERIOR en Culiacán', () => {
    const inst = new Date('2026-08-06T05:00:00Z'); // 22:00 del 05 en Mazatlan
    expect(fechaEnTz(inst, 'America/Mazatlan')).toBe('2026-08-05');
    expect(formatHoraEnTz(inst, 'America/Mazatlan')).toBe('22:00');
  });

  it('el MISMO instante se ve distinto en España (el bug que veía David)', () => {
    const inst = new Date('2026-08-06T05:00:00Z'); // 07:00 en Madrid (UTC+2 verano)
    expect(formatHoraEnTz(inst, 'Europe/Madrid')).toBe('07:00');
    expect(fechaEnTz(inst, 'Europe/Madrid')).toBe('2026-08-06');
  });
});
