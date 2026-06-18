import { describe, it, expect } from 'vitest';
import {
  generarFechasReservables,
  filtrarRecursosPorTier,
  diaNombre,
  formatDateISO,
  traducirErrorRPC,
  mensajeToastCancelacion,
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
    sucursal_id: 'suc-1',
    slug: 'estudio-1',
    nombre: 'Estudio 1',
    descripcion: null,
    tipo: 'estudio_individual',
    cupos: 1,
    cupo_max_default: 12,
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
    intensidad: null,
    ...overrides
  };
}

describe('generarFechasReservables', () => {
  it('genera anticipacion_max_dias fechas desde hoy', () => {
    const fechas = generarFechasReservables(baseConfig, 'America/Mexico_City');
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

describe('traducirErrorRPC — gate de membresía (Fase 2A.2)', () => {
  it('MEMBRESIA_VENCIDA → texto humano sin código crudo', () => {
    expect(traducirErrorRPC('MEMBRESIA_VENCIDA: Tu membresía venció el 12/06/2026')).toBe(
      'Tu membresía venció. Contactá al gimnasio para renovar.'
    );
  });
  it('SIN_CREDITOS → mensaje de recarga', () => {
    expect(traducirErrorRPC('SIN_CREDITOS: Te quedaste sin créditos')).toBe(
      'Te quedaste sin clases. Contactá al gimnasio para recargar.'
    );
  });
  it('MEMBRESIA_CONGELADA → mensaje de pausa', () => {
    expect(traducirErrorRPC('MEMBRESIA_CONGELADA: Tu membresía está pausada')).toBe(
      'Tu membresía está pausada. Contactá al gimnasio.'
    );
  });
  it('SIN_MEMBRESIA → mensaje de sin membresía', () => {
    expect(traducirErrorRPC('SIN_MEMBRESIA: No tenés una membresía activa')).toBe(
      'No tenés una membresía activa. Contactá al gimnasio.'
    );
  });
  it('códigos preexistentes siguen funcionando (regresión)', () => {
    expect(traducirErrorRPC('CUPO_LLENO: ...')).toBe(
      'Esta clase está llena. Probá con otro horario.'
    );
    expect(traducirErrorRPC('YA_RESERVADO: ...')).toBe(
      'Ya tenés una reserva activa en esta clase.'
    );
  });
});

describe('mensajeToastCancelacion', () => {
  it('a_tiempo comunica la devolución del crédito', () => {
    expect(mensajeToastCancelacion('a_tiempo')).toBe(
      'Reserva cancelada. Se devolvió tu crédito.'
    );
  });
  it('tarde aclara que no se devolvió', () => {
    expect(mensajeToastCancelacion('tarde')).toBe(
      'Reserva cancelada. Por cancelar fuera de tiempo, no se devolvió el crédito.'
    );
  });
  it('sin_credito y no_aplica usan el mensaje simple', () => {
    expect(mensajeToastCancelacion('sin_credito')).toBe('Reserva cancelada.');
    expect(mensajeToastCancelacion('no_aplica')).toBe('Reserva cancelada.');
  });
  it('undefined (RPC no devolvió motivo) → mensaje simple', () => {
    expect(mensajeToastCancelacion(undefined)).toBe('Reserva cancelada.');
  });
});
