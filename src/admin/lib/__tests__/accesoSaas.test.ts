import { describe, it, expect } from 'vitest';
import {
  estadoAccesoSaas,
  GRACIA_TRIAL_DIAS,
  GRACIA_CANCELADA_DIAS,
  GRACIA_VENCIDA_DIAS,
  PREAVISO_DIAS
} from '../accesoSaas';
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
    stripe_customer_id: 'cus_real',
    // Por defecto, suscripción que SÍ llegó a Stripe (hay tarjeta). Los casos
    // sin tarjeta lo pisan con null a propósito.
    stripe_subscription_id: 'sub_real',
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

describe('estadoAccesoSaas — sin tarjeta no hay prueba', () => {
  it('trial SIN suscripción en Stripe → BLOQUEO inmediato, aunque le sobren días', () => {
    const r = estadoAccesoSaas(
      sub({ estado: 'trial', trial_termina: enDias(30), stripe_subscription_id: null }),
      AHORA
    );
    expect(r.nivel).toBe('bloqueo');
    expect(r.motivo).toBe('sin_tarjeta');
  });

  it('recién dada de alta NO se bloquea: el webhook todavía puede estar en camino', () => {
    const r = estadoAccesoSaas(
      sub({
        estado: 'trial',
        trial_termina: enDias(7),
        stripe_subscription_id: null,
        created_at: new Date(AHORA - 60_000).toISOString() // hace 1 minuto
      }),
      AHORA
    );
    expect(r.nivel).toBe('ok');
  });

  it('pasada esa ventana, sin tarjeta SÍ se bloquea', () => {
    const r = estadoAccesoSaas(
      sub({
        estado: 'trial',
        trial_termina: enDias(7),
        stripe_subscription_id: null,
        created_at: new Date(AHORA - 60 * 60_000).toISOString() // hace 1 hora
      }),
      AHORA
    );
    expect(r.nivel).toBe('bloqueo');
    expect(r.motivo).toBe('sin_tarjeta');
  });

  it('los mock_ del checkout viejo TAMBIÉN se bloquean: nunca hubo tarjeta real', () => {
    const r = estadoAccesoSaas(
      sub({ estado: 'trial', trial_termina: enDias(10), stripe_subscription_id: 'mock_sub_123' }),
      AHORA
    );
    expect(r.nivel).toBe('bloqueo');
    expect(r.motivo).toBe('sin_tarjeta');
  });

  it('con tarjeta, el trial vigente sigue dando acceso', () => {
    const r = estadoAccesoSaas(
      sub({ estado: 'trial', trial_termina: enDias(10), stripe_subscription_id: 'sub_real' }),
      AHORA
    );
    expect(r.nivel).toBe('ok');
  });

  it('una suscripción ACTIVA sin sub_id no se bloquea (la regla es solo del trial)', () => {
    const r = estadoAccesoSaas(sub({ estado: 'activa', stripe_subscription_id: null }), AHORA);
    expect(r.nivel).toBe('ok');
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
    expect(r.diasParaCorte).toBe(GRACIA_TRIAL_DIAS - 1);
  });

  it('trial vencido hace más que la gracia → BLOQUEO', () => {
    const r = estadoAccesoSaas(sub({ estado: 'trial', trial_termina: enDias(-(GRACIA_TRIAL_DIAS + 1)) }), AHORA);
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
    const r = estadoAccesoSaas(sub({ estado: 'vencida', periodo_actual_termina: enDias(-(GRACIA_VENCIDA_DIAS + 1)) }), AHORA);
    expect(r.nivel).toBe('bloqueo');
  });
  it('vencida sin ninguna fecha (ni updated_at útil) → bloqueo', () => {
    const r = estadoAccesoSaas(
      sub({ estado: 'vencida', periodo_actual_termina: null, updated_at: enDias(-(GRACIA_VENCIDA_DIAS + 2)) }),
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
    const r = estadoAccesoSaas(sub({ estado: 'cancelada', periodo_actual_termina: enDias(-(GRACIA_CANCELADA_DIAS + 1)) }), AHORA);
    expect(r.nivel).toBe('bloqueo');
  });
  it('cancelada sin fecha de período → bloqueo', () => {
    const r = estadoAccesoSaas(sub({ estado: 'cancelada', periodo_actual_termina: null }), AHORA);
    expect(r.nivel).toBe('bloqueo');
  });

  it('NO regala días: al terminar lo que pagó, se corta el mismo día', () => {
    // Un día DESPUÉS del período pagado ya no hay acceso. Con la gracia vieja de
    // 5 días uniformes, este caso seguía abierto y el cartel llegaba a ofrecer
    // "12 días más" a alguien que pidió irse.
    const r = estadoAccesoSaas(sub({ estado: 'cancelada', periodo_actual_termina: enDias(-1) }), AHORA);
    expect(r.nivel).toBe('bloqueo');
  });
});

describe('estadoAccesoSaas — los únicos días gratis son los de la prueba', () => {
  it('el trial vencido da 1 día de margen, no 5', () => {
    const r = estadoAccesoSaas(sub({ estado: 'trial', trial_termina: enDias(-1) }), AHORA);
    // Vencido hace 1 día con 1 día de gracia → el corte es HOY: quedan 0.
    expect(r.diasParaCorte).toBe(0);
    expect(GRACIA_TRIAL_DIAS).toBe(1);
  });

  it('cancelar no suma ningún día sobre lo pagado', () => {
    expect(GRACIA_CANCELADA_DIAS).toBe(0);
  });

  it('el pago fallido SÍ conserva aire: es un cliente que paga', () => {
    expect(GRACIA_VENCIDA_DIAS).toBe(5);
    const r = estadoAccesoSaas(sub({ estado: 'vencida', periodo_actual_termina: enDias(-2) }), AHORA);
    expect(r.nivel).toBe('aviso');
  });
});