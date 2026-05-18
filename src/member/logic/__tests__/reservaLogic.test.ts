import { describe, it, expect } from 'vitest';
import {
  generarSlotsDisponibles,
  generarFechasReservables,
  filtrarRecursosPorTier,
  diaNombre,
  combinarFechaHora,
  formatDateISO,
  type TenantReservaConfig
} from '../reservaLogic';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

const baseConfig: TenantReservaConfig = {
  duracion_default_min: 60,
  cupos_por_recurso: 1,
  permitir_continuas: false,
  anticipacion_min_horas: 24,
  anticipacion_max_dias: 30,
  ventana_check_in_min: 15
};

function makeRecurso(overrides: Partial<Recurso> = {}): Recurso {
  return {
    id: 'rec-1',
    tenant_id: 'tenant-1',
    slug: 'estudio-1',
    nombre: 'Estudio 1',
    descripcion: null,
    tipo: 'estudio_individual',
    cupos: 1,
    horarios: [
      { dia: 'lunes', inicio: '09:00', fin: '12:00' },
      { dia: 'lunes', inicio: '14:00', fin: '18:00' }
    ],
    tiers_permitidos: ['basica', 'pro'],
    fotos_urls: [],
    video_url: null,
    activo: true,
    orden: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    capacidad_personas: null,
    equipo_incluido: null,
    estilo_visual: null,
    foto_url: null,
    tipo_contenido: null,
    ...overrides
  };
}

describe('generarSlotsDisponibles', () => {
  it('genera slots de 60 min en bloques separados de horario', () => {
    const recurso = makeRecurso();
    const ahora = new Date(2026, 4, 10, 8, 0); // domingo 10 may 2026 8am
    const fecha = '2026-05-11'; // lunes
    const slots = generarSlotsDisponibles(recurso, fecha, baseConfig, [], [], ahora);

    // 9-12: 3 slots (9-10, 10-11, 11-12)
    // 14-18: 4 slots (14-15, 15-16, 16-17, 17-18)
    expect(slots).toHaveLength(7);
    expect(slots[0].inicio.getHours()).toBe(9);
    expect(slots[2].inicio.getHours()).toBe(11);
    expect(slots[3].inicio.getHours()).toBe(14);
    expect(slots[6].inicio.getHours()).toBe(17);
  });

  it('marca slots pasados como no disponibles', () => {
    const recurso = makeRecurso();
    const ahora = new Date(2026, 4, 11, 11, 0); // lunes 11am
    const fecha = '2026-05-11';
    const slots = generarSlotsDisponibles(recurso, fecha, baseConfig, [], [], ahora);

    expect(slots[0].disponible).toBe(false); // 9am ya pasó
    expect(slots[0].razon).toBe('pasado');
  });

  it('marca slots dentro de anticipación mínima como no disponibles', () => {
    const recurso = makeRecurso();
    const ahora = new Date(2026, 4, 11, 8, 0); // lunes 8am
    const fecha = '2026-05-11';
    const slots = generarSlotsDisponibles(recurso, fecha, baseConfig, [], [], ahora);

    // Con anticipación de 24h, todos los slots de lunes están dentro de las 24h
    const tieneAnticipacionInsuficiente = slots.some(
      (s) => !s.disponible && s.razon === 'anticipacion_insuficiente'
    );
    expect(tieneAnticipacionInsuficiente).toBe(true);
  });

  it('marca slots ocupados como no disponibles', () => {
    const recurso = makeRecurso();
    const ahora = new Date(2026, 4, 10, 8, 0); // dom 8am
    const fecha = '2026-05-11';
    const slotOcupado = combinarFechaHora(fecha, '10:00');

    const slots = generarSlotsDisponibles(
      recurso,
      fecha,
      baseConfig,
      [{ slot_inicio: slotOcupado.toISOString() }],
      [],
      ahora
    );

    const slot10 = slots.find((s) => s.inicio.getHours() === 10);
    expect(slot10?.disponible).toBe(false);
    expect(slot10?.razon).toBe('ocupado');
  });

  it('marca slots continuos del usuario como no disponibles cuando regla está activa', () => {
    const recurso = makeRecurso();
    const ahora = new Date(2026, 4, 10, 8, 0);
    const fecha = '2026-05-11';
    const usuarioYaReservadoEn10am = combinarFechaHora(fecha, '10:00');

    const slots = generarSlotsDisponibles(
      recurso,
      fecha,
      baseConfig, // permitir_continuas: false
      [],
      [{ slot_inicio: usuarioYaReservadoEn10am.toISOString() }],
      ahora
    );

    // slot 9-10 (anterior) y 11-12 (siguiente) deberían estar bloqueados como 'continuo'
    const slot9 = slots.find((s) => s.inicio.getHours() === 9);
    const slot11 = slots.find((s) => s.inicio.getHours() === 11);
    expect(slot9?.razon).toBe('continuo');
    expect(slot11?.razon).toBe('continuo');
  });

  it('permite continuos si tenant los permite', () => {
    const recurso = makeRecurso();
    const ahora = new Date(2026, 4, 10, 8, 0);
    const fecha = '2026-05-11';
    const configPermite = { ...baseConfig, permitir_continuas: true };
    const usuarioYaReservadoEn10am = combinarFechaHora(fecha, '10:00');

    const slots = generarSlotsDisponibles(
      recurso,
      fecha,
      configPermite,
      [],
      [{ slot_inicio: usuarioYaReservadoEn10am.toISOString() }],
      ahora
    );

    const slot9 = slots.find((s) => s.inicio.getHours() === 9);
    const slot11 = slots.find((s) => s.inicio.getHours() === 11);
    expect(slot9?.disponible).toBe(true);
    expect(slot11?.disponible).toBe(true);
  });

  it('devuelve [] si el recurso no opera ese día', () => {
    const recurso = makeRecurso({
      horarios: [{ dia: 'lunes', inicio: '09:00', fin: '18:00' }]
    });
    const fecha = '2026-05-12'; // martes
    const slots = generarSlotsDisponibles(recurso, fecha, baseConfig, [], [], new Date(2026, 4, 10));
    expect(slots).toEqual([]);
  });
});

describe('generarFechasReservables', () => {
  it('genera anticipacion_max_dias fechas desde hoy', () => {
    const ahora = new Date(2026, 4, 14, 12, 0);
    const fechas = generarFechasReservables(baseConfig, ahora);
    expect(fechas).toHaveLength(30);
    expect(fechas[0].label).toBe('Hoy');
    expect(fechas[1].label).toBe('Mañana');
  });
});

describe('filtrarRecursosPorTier', () => {
  it('básica no ve recurso Pro-only', () => {
    const black = makeRecurso({ slug: 'black', tiers_permitidos: ['pro'] });
    const e1 = makeRecurso({ slug: 'estudio-1', tiers_permitidos: ['basica', 'pro'] });
    const filtrados = filtrarRecursosPorTier([black, e1], 'basica');
    expect(filtrados).toHaveLength(1);
    expect(filtrados[0].slug).toBe('estudio-1');
  });

  it('pro ve todos', () => {
    const black = makeRecurso({ slug: 'black', tiers_permitidos: ['pro'] });
    const e1 = makeRecurso({ slug: 'estudio-1', tiers_permitidos: ['basica', 'pro'] });
    const filtrados = filtrarRecursosPorTier([black, e1], 'pro');
    expect(filtrados).toHaveLength(2);
  });
});

describe('utilidades de fecha', () => {
  it('diaNombre devuelve nombre en español', () => {
    const lunes = new Date(2026, 4, 11);
    expect(diaNombre(lunes)).toBe('lunes');
  });

  it('formatDateISO produce YYYY-MM-DD local', () => {
    const d = new Date(2026, 4, 14, 23, 30);
    expect(formatDateISO(d)).toBe('2026-05-14');
  });
});
