import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useOperationKey,
  nuevaOperationKey,
  esConflictoIdempotencia,
  MSG_CONFLICTO_IDEMPOTENCIA
} from '../operationKey';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('esConflictoIdempotencia', () => {
  it('detecta el código IDEMPOTENCY_CONFLICT (al inicio o en medio)', () => {
    expect(esConflictoIdempotencia('IDEMPOTENCY_CONFLICT: datos distintos')).toBe(true);
    expect(esConflictoIdempotencia('pg error: IDEMPOTENCY_CONFLICT foo')).toBe(true);
  });
  it('no marca otros errores ni valores vacíos', () => {
    expect(esConflictoIdempotencia('MONTO_EXCEDE: ...')).toBe(false);
    expect(esConflictoIdempotencia('')).toBe(false);
    expect(esConflictoIdempotencia(null)).toBe(false);
    expect(esConflictoIdempotencia(undefined)).toBe(false);
  });
  it('el mensaje neutro es claro', () => {
    expect(MSG_CONFLICTO_IDEMPOTENCIA).toMatch(/ya se registró/i);
  });
});

describe('nuevaOperationKey', () => {
  it('genera UUIDs distintos', () => {
    const a = nuevaOperationKey();
    const b = nuevaOperationKey();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });
});

describe('useOperationKey', () => {
  it('sobrevive al reintento: misma entrada → la MISMA key entre renders', () => {
    const { result, rerender } = renderHook(({ inputs }) => useOperationKey(inputs), {
      initialProps: { inputs: ['socioA', 'tierX', 'efectivo'] as unknown[] }
    });
    const k1 = result.current;
    expect(k1).toMatch(UUID_RE);
    // Reintento (mismo contenido, nuevo arreglo) → key estable.
    rerender({ inputs: ['socioA', 'tierX', 'efectivo'] });
    expect(result.current).toBe(k1);
    rerender({ inputs: ['socioA', 'tierX', 'efectivo'] });
    expect(result.current).toBe(k1);
  });

  it('operación genuinamente nueva (cambia una entrada material) → key NUEVA', () => {
    const { result, rerender } = renderHook(({ inputs }) => useOperationKey(inputs), {
      initialProps: { inputs: ['socioA', 'tierX', 'efectivo'] as unknown[] }
    });
    const k1 = result.current;
    rerender({ inputs: ['socioA', 'tierY', 'efectivo'] }); // cambió el plan
    const k2 = result.current;
    expect(k2).not.toBe(k1);
    rerender({ inputs: ['socioA', 'tierY', 'tarjeta'] }); // cambió el método
    expect(result.current).not.toBe(k2);
  });

  it('dos operaciones simultáneas (dos hooks) → keys distintas aunque la entrada sea igual', () => {
    const a = renderHook(() => useOperationKey(['x', 'y']));
    const b = renderHook(() => useOperationKey(['x', 'y']));
    expect(a.result.current).not.toBe(b.result.current);
  });
});
