import { describe, it, expect } from 'vitest';
import { estadoAccesoSaas, GRACIA_DIAS, PREAVISO_DIAS } from '../accesoSaas';
import type { SuscripcionSaas } from '../../hooks/useSuscripcion';

function sub(over: Partial<SuscripcionSaas>): SuscripcionSaas {
  return {
    id: 's1',
    tenant_id: 't1',
    tier: 'pro',
    moneda: 'mxn',
    estado: 'activa',
    trial_termina: null,
    periodo_actual_termina: null,
    precio_centavos: 390000,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    cancelada_at: null,
    ...over
  } as SuscripcionSaas;
}

const AHORA = Date.parse('2026-07-15T12:00:00Z');
const DIA = 86_400_000;
const enDias = (n: number) => new Date(AHORA + n * DIA).toISOString();

describe('estadoAccesoSaas — falla ABIERTO', () => {
  it('sin suscripción → ok', () => {
    expect(estadoAccesoSaas(null, AHORA).nivel).toBe('ok');
  });
  it('activa → ok (auto-renueva)', () => {
    expect(estadoAccesoSaas(sub({ estado: 'activa' }), AHORA).nivel).toBe('ok');
  });
  it('pausada → ok', () => {
    expect(estadoAccesoSaas(sub({ estado: 'pausada' }), AHORA).nivel).toBe('ok');
  });
});

describe('estadoAccesoSaas — trial (preaviso → gracia → corte)', () => {
  it('trial lejos del vencimiento → ok', () => {
    expect(estadoAccesoSaas(sub({ estado: 'trial', trial_termina: enDias(10) }), AHORA).nivel).toBe('ok');
  });

  it(`trial que vence dentro de ${PREAVISO_DIAS} días → aviso (por vencer)`, () => {
    const r = estadoAccesoSaas(sub({ estado: 'trial', trial_termina: enDias(2) }), AHORA);
    expect(r.nivel).toBe('aviso');
    expect(r.motivo).toBe('trial_por_vencer');
  });

  it('trial recién vencido → AVISO (gracia), no bloqueo', () => {
    const r = estadoAccesoSaas(sub({ estado: 'trial', trial_termina: enDias(-1) }), AHORA);
    expect(r.nivel).toBe('aviso');
    expect(r.motivo).toBe('trial_vencido');
    expect(r.diasParaCorte).toBe(GRACIA_DIAS - 1);
  });

  it('trial vencido hace más que la gracia → BLOQUEO', () => {
    const r = estadoAccesoSaas(sub({ estado: 'trial', trial_termina: enDias(-(GRACIA_DIAS + 1)) }), AHORA);
    expect(r.nivel).toBe('bloqueo');
    expect(r.motivo).toBe('trial_vencido');
  });

  it('trial sin fecha → ok (sin señal clara)', () => {
    expect(estadoAccesoSaas(sub({ estado: 'trial', trial_termina: null }), AHORA).nivel).toBe('ok');
  });
});

describe('estadoAccesoSaas — vencida (pago falló)', () => {
  it('recién vencida (dentro de la gracia) → aviso, sigue operando', () => {
    const r = estadoAccesoSaas(sub({ estado: 'vencida', periodo_actual_termina: enDias(-1) }), AHORA);
    expect(r.nivel).toBe('aviso');
    expect(r.motivo).toBe('vencida');
  });
  it('vencida pasada la gracia → bloqueo', () => {
    const r = estadoAccesoSaas(sub({ estado: 'vencida', periodo_actual_termina: enDias(-(GRACIA_DIAS + 1)) }), AHORA);
    expect(r.nivel).toBe('bloqueo');
  });
  it('vencida sin ninguna fecha (ni updated_at útil) → bloqueo', () => {
    const r = estadoAccesoSaas(
      sub({ estado: 'vencida', periodo_actual_termina: null, updated_at: enDias(-(GRACIA_DIAS + 2)) }),
      AHORA
    );
    expect(r.nivel).toBe('bloqueo');
  });
});

describe('estadoAccesoSaas — cancelada', () => {
  it('cancelada pero pagó hasta una fecha futura → aviso, no corta', () => {
    const r = estadoAccesoSaas(sub({ estado: 'cancelada', periodo_actual_termina: enDias(5) }), AHORA);
    expect(r.nivel).toBe('aviso');
    expect(r.motivo).toBe('cancelada');
  });
  it('cancelada, período terminado hace más que la gracia → bloqueo', () => {
    const r = estadoAccesoSaas(sub({ estado: 'cancelada', periodo_actual_termina: enDias(-(GRACIA_DIAS + 1)) }), AHORA);
    expect(r.nivel).toBe('bloqueo');
  });
  it('cancelada sin fecha de período → bloqueo', () => {
    const r = estadoAccesoSaas(sub({ estado: 'cancelada', periodo_actual_termina: null }), AHORA);
    expect(r.nivel).toBe('bloqueo');
  });
});