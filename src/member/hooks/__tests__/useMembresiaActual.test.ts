import { describe, it, expect } from 'vitest';
import {
  membresiaEstado,
  type MembresiaActual,
  type TipoTier
} from '../useMembresiaActual';

// W5: la VIGENCIA es canónica (m.vigente, del servidor). membresiaEstado ya no
// deriva vencida por fecha; mapea vigente + status + tipo + créditos al display.
function mem(overrides: Partial<MembresiaActual> = {}): MembresiaActual {
  const base: MembresiaActual = {
    id: 'm-1',
    status: 'activa',
    cancelada_at: null,
    cancelada_efectiva_at: null,
    periodo_actual_inicio: '2026-05-13T00:00:00Z',
    periodo_actual_fin: '2026-06-12T00:00:00Z',
    creditos_restantes: null,
    tier_id: 'tier-1',
    tier_slug: 'pro',
    tier_nombre: 'Pro',
    tier_tipo: 'tiempo',
    duracion_dias: 30,
    clases_incluidas: null,
    sucursal_id: null,
    tier_acceso_todas_sucursales: true,
    es_pase: false,
    vigente: true
  };
  return { ...base, ...overrides };
}

describe('membresiaEstado', () => {
  it('null → sin_membresia', () => {
    expect(membresiaEstado(null)).toBe('sin_membresia');
  });

  it("status='congelada' → congelada (gana sobre vencida/créditos)", () => {
    expect(
      membresiaEstado(
        mem({ status: 'congelada', vigente: false, tier_tipo: 'creditos', creditos_restantes: 0 })
      )
    ).toBe('congelada');
  });

  it("status='past_due' → past_due (dunning)", () => {
    expect(membresiaEstado(mem({ status: 'past_due', vigente: false }))).toBe('past_due');
  });

  it('no vigente (activa vencida) → vencida (gana sobre sin_creditos en híbrido)', () => {
    expect(
      membresiaEstado(mem({ vigente: false, tier_tipo: 'hibrido', creditos_restantes: 0 }))
    ).toBe('vencida');
  });

  it('tipo=tiempo, vigente → sana', () => {
    expect(membresiaEstado(mem({ tier_tipo: 'tiempo', vigente: true }))).toBe('sana');
  });

  it('tipo=tiempo, no vigente → vencida', () => {
    expect(membresiaEstado(mem({ tier_tipo: 'tiempo', vigente: false }))).toBe('vencida');
  });

  it('tipo=creditos, vigente, saldo>0 (fin null) → sana', () => {
    expect(
      membresiaEstado(mem({ tier_tipo: 'creditos', creditos_restantes: 5, periodo_actual_fin: null, vigente: true }))
    ).toBe('sana');
  });

  it('tipo=creditos, vigente, saldo=0 → sin_creditos', () => {
    expect(
      membresiaEstado(mem({ tier_tipo: 'creditos', creditos_restantes: 0, periodo_actual_fin: null, vigente: true }))
    ).toBe('sin_creditos');
  });

  it('tipo=creditos, vigente, saldo null → sin_creditos (tratado como 0)', () => {
    expect(
      membresiaEstado(mem({ tier_tipo: 'creditos', creditos_restantes: null, periodo_actual_fin: null, vigente: true }))
    ).toBe('sin_creditos');
  });

  it('tipo=hibrido vigente con créditos → sana', () => {
    expect(membresiaEstado(mem({ tier_tipo: 'hibrido', creditos_restantes: 5, vigente: true }))).toBe('sana');
  });

  it('tipo=hibrido vigente sin créditos → sin_creditos', () => {
    expect(membresiaEstado(mem({ tier_tipo: 'hibrido', creditos_restantes: 0, vigente: true }))).toBe('sin_creditos');
  });

  it.each<[TipoTier]>([['tiempo'], ['creditos'], ['hibrido']])(
    'vigente (tipo=%s) con créditos ok → sana',
    (tipo) => {
      const m = mem({
        tier_tipo: tipo,
        periodo_actual_fin: null,
        creditos_restantes: tipo === 'tiempo' ? null : 5,
        vigente: true
      });
      expect(membresiaEstado(m)).toBe('sana');
    }
  );
});
