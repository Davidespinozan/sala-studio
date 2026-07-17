import { describe, it, expect } from 'vitest';
import { motivoBloqueoSaas } from '../accesoSaas';
import type { SuscripcionSaas } from '../../hooks/useSuscripcion';

// Base mínima; cada test pisa lo que le importa. Los campos no relevantes para
// el paywall se dejan en valores plausibles.
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
const AYER = '2026-07-14T12:00:00Z';
const MANANA = '2026-07-16T12:00:00Z';

describe('motivoBloqueoSaas — falla ABIERTO', () => {
  it('sin suscripción NO bloquea (no sabemos → dejamos pasar)', () => {
    expect(motivoBloqueoSaas(null, AHORA)).toBeNull();
  });

  it('activa NO bloquea', () => {
    expect(motivoBloqueoSaas(sub({ estado: 'activa' }), AHORA)).toBeNull();
  });

  it('pausada NO bloquea (ambiguo, se revisa aparte)', () => {
    expect(motivoBloqueoSaas(sub({ estado: 'pausada' }), AHORA)).toBeNull();
  });
});

describe('motivoBloqueoSaas — trial', () => {
  it('trial vigente (termina mañana) NO bloquea', () => {
    expect(motivoBloqueoSaas(sub({ estado: 'trial', trial_termina: MANANA }), AHORA)).toBeNull();
  });

  it('trial vencido (terminó ayer) bloquea', () => {
    expect(motivoBloqueoSaas(sub({ estado: 'trial', trial_termina: AYER }), AHORA)).toBe('trial_vencido');
  });

  it('trial sin fecha NO bloquea (no hay señal clara)', () => {
    expect(motivoBloqueoSaas(sub({ estado: 'trial', trial_termina: null }), AHORA)).toBeNull();
  });
});

describe('motivoBloqueoSaas — cancelada', () => {
  it('cancelada con período aún vigente NO bloquea (cancela al fin de período)', () => {
    expect(
      motivoBloqueoSaas(sub({ estado: 'cancelada', periodo_actual_termina: MANANA }), AHORA)
    ).toBeNull();
  });

  it('cancelada con período ya terminado bloquea', () => {
    expect(
      motivoBloqueoSaas(sub({ estado: 'cancelada', periodo_actual_termina: AYER }), AHORA)
    ).toBe('cancelada');
  });

  it('cancelada sin fecha de período bloquea', () => {
    expect(
      motivoBloqueoSaas(sub({ estado: 'cancelada', periodo_actual_termina: null }), AHORA)
    ).toBe('cancelada');
  });
});

describe('motivoBloqueoSaas — vencida', () => {
  it('vencida (Stripe agotó reintentos) bloquea', () => {
    expect(motivoBloqueoSaas(sub({ estado: 'vencida' }), AHORA)).toBe('vencida');
  });
});