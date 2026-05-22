import { describe, it, expect } from 'vitest';
import {
  horariosSolapan,
  buscarSolape,
  type HorarioSolapable
} from '../horarioOverlap';

function h(overrides: Partial<HorarioSolapable> = {}): HorarioSolapable {
  return {
    id: 'h-1',
    recurso_id: 'sala-a',
    dias_semana: [1, 2, 3], // Lun, Mar, Mié
    hora_inicio: '07:00',
    duracion_minutos: 60,
    activo: true,
    ...overrides
  };
}

// ============================================================================
// horariosSolapan — lógica pura de solapamiento
// ============================================================================

describe('horariosSolapan', () => {
  it('días que cruzan + horas que se pisan → solapa', () => {
    // Lun-Mié 07:00-08:00 vs Mar-Jue 07:30-08:30
    const a = h({ dias_semana: [1, 2, 3], hora_inicio: '07:00', duracion_minutos: 60 });
    const b = h({ dias_semana: [2, 3, 4], hora_inicio: '07:30', duracion_minutos: 60 });
    expect(horariosSolapan(a, b)).toBe(true);
  });

  it('días que cruzan + horas que NO se pisan → no solapa', () => {
    const a = h({ hora_inicio: '07:00', duracion_minutos: 60 }); // 07:00-08:00
    const b = h({ hora_inicio: '10:00', duracion_minutos: 60 }); // 10:00-11:00
    expect(horariosSolapan(a, b)).toBe(false);
  });

  it('adyacentes (fin == inicio) → NO solapa', () => {
    const a = h({ hora_inicio: '07:00', duracion_minutos: 60 }); // termina 08:00
    const b = h({ hora_inicio: '08:00', duracion_minutos: 60 }); // empieza 08:00
    expect(horariosSolapan(a, b)).toBe(false);
  });

  it('días que NO cruzan, mismas horas → no solapa', () => {
    const a = h({ dias_semana: [1, 3, 5] }); // Lun, Mié, Vie
    const b = h({ dias_semana: [2, 4, 6] }); // Mar, Jue, Sáb
    expect(horariosSolapan(a, b)).toBe(false);
  });

  it('distinta sala, mismo día/hora → no solapa', () => {
    const a = h({ recurso_id: 'sala-a' });
    const b = h({ recurso_id: 'sala-b' });
    expect(horariosSolapan(a, b)).toBe(false);
  });

  it('solape parcial de días (Lun-Vie vs Mié-Dom comparten Mié-Vie)', () => {
    const a = h({ dias_semana: [1, 2, 3, 4, 5] });
    const b = h({ dias_semana: [3, 4, 5, 6, 0] });
    expect(horariosSolapan(a, b)).toBe(true);
  });

  it('solape parcial de horas (07:00-08:30 vs 08:00-09:00)', () => {
    const a = h({ hora_inicio: '07:00', duracion_minutos: 90 }); // 07:00-08:30
    const b = h({ hora_inicio: '08:00', duracion_minutos: 60 }); // 08:00-09:00
    expect(horariosSolapan(a, b)).toBe(true);
  });

  it('acepta hora_inicio con segundos (HH:MM:SS)', () => {
    const a = h({ hora_inicio: '07:00:00', duracion_minutos: 60 });
    const b = h({ hora_inicio: '07:30:00', duracion_minutos: 60 });
    expect(horariosSolapan(a, b)).toBe(true);
  });
});

// ============================================================================
// buscarSolape — contra una lista, excluyéndose a sí mismo
// ============================================================================

describe('buscarSolape', () => {
  it('encuentra el horario en conflicto', () => {
    const candidato = h({ id: 'nuevo', hora_inicio: '07:30', duracion_minutos: 60 });
    const existentes = [
      h({ id: 'h-otro', hora_inicio: '07:00', duracion_minutos: 60 })
    ];
    expect(buscarSolape(candidato, existentes)?.id).toBe('h-otro');
  });

  it('un horario inactivo existente NO bloquea', () => {
    const candidato = h({ id: 'nuevo', hora_inicio: '07:30', duracion_minutos: 60 });
    const existentes = [
      h({ id: 'h-inactivo', hora_inicio: '07:00', duracion_minutos: 60, activo: false })
    ];
    expect(buscarSolape(candidato, existentes)).toBeNull();
  });

  it('al editar, se excluye a sí mismo (no choca consigo mismo)', () => {
    // El candidato ES uno de los existentes (mismo id) → no debe matchearse.
    const propio = h({ id: 'h-edit', hora_inicio: '07:00', duracion_minutos: 60 });
    const existentes = [propio];
    expect(buscarSolape(propio, existentes)).toBeNull();
  });

  it('no marca solape si no hay ninguno', () => {
    const candidato = h({ id: 'nuevo', hora_inicio: '10:00', duracion_minutos: 60 });
    const existentes = [
      h({ id: 'h-otro', hora_inicio: '07:00', duracion_minutos: 60 })
    ];
    expect(buscarSolape(candidato, existentes)).toBeNull();
  });

  it('distinta sala no bloquea aunque coincida día/hora', () => {
    const candidato = h({ id: 'nuevo', recurso_id: 'sala-a' });
    const existentes = [h({ id: 'h-otro', recurso_id: 'sala-b' })];
    expect(buscarSolape(candidato, existentes)).toBeNull();
  });
});
