import { describe, it, expect } from 'vitest';
import {
  previewGestionarMembresia,
  type MembresiaActualResumen,
  type TierResumen
} from '../membresiaPreview';

const NOW = new Date('2026-05-24T12:00:00Z');

const TIER_TIEMPO_30D: TierResumen = {
  tipo: 'tiempo',
  duracion_dias: 30,
  clases_incluidas: null
};

const TIER_CREDITOS_10: TierResumen = {
  tipo: 'creditos',
  duracion_dias: null,
  clases_incluidas: 10
};

const TIER_HIBRIDO_8_X_30D: TierResumen = {
  tipo: 'hibrido',
  duracion_dias: 30,
  clases_incluidas: 8
};

function actual(overrides: Partial<MembresiaActualResumen> = {}): MembresiaActualResumen {
  return {
    tier_tipo: 'tiempo',
    periodo_actual_fin: '2026-06-12T00:00:00Z',
    creditos_restantes: null,
    ...overrides
  };
}

describe('previewGestionarMembresia — alta nueva', () => {
  it('sin membresía previa, tier tiempo → alta con fin = now + 30d', () => {
    const p = previewGestionarMembresia(null, TIER_TIEMPO_30D, NOW);
    expect(p.modo).toBe('alta');
    expect(p.nuevoSaldo).toBeNull();
    expect(p.delta).toBe(0);
    expect(p.creditosPerdidos).toBe(0);
    expect(p.nuevoFin?.toISOString()).toBe('2026-06-23T12:00:00.000Z');
  });

  it('sin membresía previa, tier creditos → alta con saldo=10, sin fin', () => {
    const p = previewGestionarMembresia(null, TIER_CREDITOS_10, NOW);
    expect(p.modo).toBe('alta');
    expect(p.nuevoFin).toBeNull();
    expect(p.nuevoSaldo).toBe(10);
    expect(p.delta).toBe(10);
  });
});

describe('previewGestionarMembresia — renovación mismo tipo', () => {
  it('tiempo vigente → renovacion, fin = fin_anterior + 30d', () => {
    const a = actual({ periodo_actual_fin: '2026-06-03T12:00:00Z' });
    const p = previewGestionarMembresia(a, TIER_TIEMPO_30D, NOW);
    expect(p.modo).toBe('renovacion');
    expect(p.nuevoFin?.toISOString()).toBe('2026-07-03T12:00:00.000Z');
    expect(p.nuevoSaldo).toBeNull();
    expect(p.delta).toBe(0);
  });

  it('tiempo vencida → renovacion_desde_hoy, fin = now + 30d', () => {
    const a = actual({ periodo_actual_fin: '2026-05-10T00:00:00Z' });
    const p = previewGestionarMembresia(a, TIER_TIEMPO_30D, NOW);
    expect(p.modo).toBe('renovacion_desde_hoy');
    expect(p.nuevoFin?.toISOString()).toBe('2026-06-23T12:00:00.000Z');
  });

  it('creditos→creditos suma saldo', () => {
    const a = actual({
      tier_tipo: 'creditos',
      periodo_actual_fin: null,
      creditos_restantes: 3
    });
    const p = previewGestionarMembresia(a, TIER_CREDITOS_10, NOW);
    expect(p.modo).toBe('renovacion');
    expect(p.nuevoSaldo).toBe(13);
    expect(p.delta).toBe(10);
    expect(p.creditosPerdidos).toBe(0);
    expect(p.nuevoFin).toBeNull();
  });

  it('hibrido→hibrido vigente: suma fechas + suma saldo', () => {
    const a: MembresiaActualResumen = {
      tier_tipo: 'hibrido',
      periodo_actual_fin: '2026-06-13T12:00:00Z',
      creditos_restantes: 4
    };
    const p = previewGestionarMembresia(a, TIER_HIBRIDO_8_X_30D, NOW);
    expect(p.modo).toBe('renovacion');
    expect(p.nuevoSaldo).toBe(12);
    expect(p.nuevoFin?.toISOString()).toBe('2026-07-13T12:00:00.000Z');
  });
});

describe('previewGestionarMembresia — cambio de tipo', () => {
  it('creditos→tiempo: resetea saldo a NULL, calcula créditos perdidos', () => {
    const a: MembresiaActualResumen = {
      tier_tipo: 'creditos',
      periodo_actual_fin: null,
      creditos_restantes: 5
    };
    const p = previewGestionarMembresia(a, TIER_TIEMPO_30D, NOW);
    expect(p.modo).toBe('cambio_de_tipo');
    expect(p.nuevoSaldo).toBeNull();
    expect(p.creditosPerdidos).toBe(5);
    expect(p.delta).toBe(-5);
    expect(p.nuevoFin?.toISOString()).toBe('2026-06-23T12:00:00.000Z');
  });

  it('tiempo→creditos: resetea saldo, sin créditos previos perdidos', () => {
    const a = actual({
      tier_tipo: 'tiempo',
      periodo_actual_fin: '2026-06-12T00:00:00Z',
      creditos_restantes: null
    });
    const p = previewGestionarMembresia(a, TIER_CREDITOS_10, NOW);
    expect(p.modo).toBe('cambio_de_tipo');
    expect(p.nuevoSaldo).toBe(10);
    expect(p.creditosPerdidos).toBe(0);
    expect(p.delta).toBe(10);
    expect(p.nuevoFin).toBeNull();
  });

  it('hibrido→creditos: resetea saldo, calcula perdidos', () => {
    const a: MembresiaActualResumen = {
      tier_tipo: 'hibrido',
      periodo_actual_fin: '2026-06-12T00:00:00Z',
      creditos_restantes: 7
    };
    const p = previewGestionarMembresia(a, TIER_CREDITOS_10, NOW);
    expect(p.modo).toBe('cambio_de_tipo');
    expect(p.nuevoSaldo).toBe(10);
    expect(p.creditosPerdidos).toBe(7);
    expect(p.delta).toBe(3);
    expect(p.nuevoFin).toBeNull();
  });

  it('creditos→tiempo con saldo=0: NO marca perdidos (no había nada que perder)', () => {
    const a: MembresiaActualResumen = {
      tier_tipo: 'creditos',
      periodo_actual_fin: null,
      creditos_restantes: 0
    };
    const p = previewGestionarMembresia(a, TIER_TIEMPO_30D, NOW);
    expect(p.modo).toBe('cambio_de_tipo');
    expect(p.creditosPerdidos).toBe(0);
  });
});

describe('previewGestionarMembresia — bordes', () => {
  it('tier nuevo con duracion_dias=null y mismo tipo → fin queda null', () => {
    const a: MembresiaActualResumen = {
      tier_tipo: 'creditos',
      periodo_actual_fin: '2026-06-12T00:00:00Z',
      creditos_restantes: 2
    };
    const tierEterno: TierResumen = {
      tipo: 'creditos',
      duracion_dias: null,
      clases_incluidas: 5
    };
    const p = previewGestionarMembresia(a, tierEterno, NOW);
    expect(p.modo).toBe('renovacion');
    expect(p.nuevoFin).toBeNull();
    expect(p.nuevoSaldo).toBe(7);
  });
});
