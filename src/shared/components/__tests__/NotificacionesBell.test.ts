import { describe, it, expect } from 'vitest';
import { rutaDeFicha } from '../NotificacionesBell';
import type { Notificacion } from '@shared/hooks/useNotificaciones';

const base = (over: Partial<Notificacion>): Notificacion => ({
  id: 'n1', tipo: 'pago_rechazado', titulo: 't', mensaje: 'm', metadata: null, creada_at: '2026-01-01', leida: false, ...over
});

describe('W6-D — NotificacionesBell: rutaDeFicha (navegación segura)', () => {
  it('admin + metadata.usuario_id → navega a la ficha', () => {
    expect(rutaDeFicha(base({ metadata: { usuario_id: 'u1' } }), true)).toBe('/admin/miembros/u1');
  });

  it('no-admin (ej. recepción) → nunca navega, aunque haya metadata', () => {
    expect(rutaDeFicha(base({ metadata: { usuario_id: 'u1' } }), false)).toBeNull();
  });

  it('metadata ausente (null) → no navega, no revienta', () => {
    expect(rutaDeFicha(base({ metadata: null }), true)).toBeNull();
  });

  it('metadata legacy sin usuario_id (ej. contracargo abierto hoy: {}) → no navega', () => {
    expect(rutaDeFicha(base({ metadata: {} }), true)).toBeNull();
  });

  it('usuario_id con tipo equivocado (no string) → no navega', () => {
    expect(rutaDeFicha(base({ metadata: { usuario_id: 123 } }), true)).toBeNull();
  });

  it('tipo de notificación no financiero → no navega aunque haya metadata', () => {
    expect(rutaDeFicha(base({ tipo: 'clase_cancelada', metadata: { usuario_id: 'u1' } }), true)).toBeNull();
  });

  it('cubre los 4 tipos de dinero con metadata completa', () => {
    for (const tipo of ['pago_rechazado', 'contracargo', 'refund_exitoso', 'contracargo_resuelto']) {
      expect(rutaDeFicha(base({ tipo, metadata: { usuario_id: 'u1' } }), true)).toBe('/admin/miembros/u1');
    }
  });
});
