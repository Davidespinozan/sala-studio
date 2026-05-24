import { describe, it, expect } from 'vitest';
import {
  membresiaEstado,
  type MembresiaActual,
  type TipoTier
} from '../useMembresiaActual';

const NOW = new Date('2026-05-24T12:00:00Z');

function mem(overrides: Partial<MembresiaActual> = {}): MembresiaActual {
  const base: MembresiaActual = {
    id: 'm-1',
    status: 'activa',
    periodo_actual_inicio: '2026-05-13T00:00:00Z',
    periodo_actual_fin: '2026-06-12T00:00:00Z',
    creditos_restantes: null,
    tier_id: 'tier-1',
    tier_slug: 'pro',
    tier_nombre: 'Pro',
    tier_tipo: 'tiempo',
    duracion_dias: 30,
    clases_incluidas: null
  };
  return { ...base, ...overrides };
}

describe('membresiaEstado', () => {
  it('null → sin_membresia', () => {
    expect(membresiaEstado(null, NOW)).toBe('sin_membresia');
  });

  it("status='congelada' → congelada (gana sobre vencida/créditos)", () => {
    expect(
      membresiaEstado(
        mem({
          status: 'congelada',
          periodo_actual_fin: '2026-04-01T00:00:00Z', // también vencida
          tier_tipo: 'creditos',
          creditos_restantes: 0
        }),
        NOW
      )
    ).toBe('congelada');
  });

  it('periodo_actual_fin <= now → vencida (gana sobre sin_creditos en híbrido)', () => {
    expect(
      membresiaEstado(
        mem({
          periodo_actual_fin: '2026-05-23T00:00:00Z',
          tier_tipo: 'hibrido',
          creditos_restantes: 0
        }),
        NOW
      )
    ).toBe('vencida');
  });

  it('tipo=tiempo, fin futuro → sana', () => {
    expect(membresiaEstado(mem({ tier_tipo: 'tiempo' }), NOW)).toBe('sana');
  });

  it('tipo=tiempo, fin pasado → vencida', () => {
    expect(
      membresiaEstado(
        mem({ tier_tipo: 'tiempo', periodo_actual_fin: '2026-04-01T00:00:00Z' }),
        NOW
      )
    ).toBe('vencida');
  });

  it('tipo=creditos, saldo>0 → sana (aunque fin sea null)', () => {
    expect(
      membresiaEstado(
        mem({ tier_tipo: 'creditos', creditos_restantes: 5, periodo_actual_fin: null }),
        NOW
      )
    ).toBe('sana');
  });

  it('tipo=creditos, saldo=0 → sin_creditos', () => {
    expect(
      membresiaEstado(
        mem({ tier_tipo: 'creditos', creditos_restantes: 0, periodo_actual_fin: null }),
        NOW
      )
    ).toBe('sin_creditos');
  });

  it('tipo=creditos, saldo null → sin_creditos (tratado como 0)', () => {
    expect(
      membresiaEstado(
        mem({ tier_tipo: 'creditos', creditos_restantes: null, periodo_actual_fin: null }),
        NOW
      )
    ).toBe('sin_creditos');
  });

  it('tipo=hibrido vigente con créditos → sana', () => {
    expect(
      membresiaEstado(
        mem({ tier_tipo: 'hibrido', creditos_restantes: 5 }),
        NOW
      )
    ).toBe('sana');
  });

  it('tipo=hibrido vigente sin créditos → sin_creditos', () => {
    expect(
      membresiaEstado(
        mem({ tier_tipo: 'hibrido', creditos_restantes: 0 }),
        NOW
      )
    ).toBe('sin_creditos');
  });

  it('borde: fin === now → vencida (consistente con el gate: fin <= now)', () => {
    const fin = '2026-05-24T12:00:00Z';
    expect(membresiaEstado(mem({ periodo_actual_fin: fin }), NOW)).toBe('vencida');
  });

  it.each<[TipoTier]>([['tiempo'], ['creditos'], ['hibrido']])(
    'sin periodo_actual_fin (tipo=%s) no marca vencida',
    (tipo) => {
      const m = mem({
        tier_tipo: tipo,
        periodo_actual_fin: null,
        creditos_restantes: tipo === 'tiempo' ? null : 5
      });
      expect(membresiaEstado(m, NOW)).toBe('sana');
    }
  );
});
