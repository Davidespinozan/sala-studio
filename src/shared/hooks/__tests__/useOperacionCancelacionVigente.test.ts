import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const rpcMock = vi.fn();
vi.mock('@shared/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) }
}));

import { useOperacionCancelacionVigente } from '../useOperacionCancelacionVigente';

describe('useOperacionCancelacionVigente', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sin usuarioId: ninguna, sin consultar', async () => {
    const { result } = renderHook(() => useOperacionCancelacionVigente(undefined));
    await waitFor(() => expect(result.current.estado).toBe('ninguna'));
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('data truthy → en_curso', async () => {
    rpcMock.mockResolvedValue({ data: { operacion_id: 'op-1' }, error: null });
    const { result } = renderHook(() => useOperacionCancelacionVigente('u-1'));
    await waitFor(() => expect(result.current.estado).toBe('en_curso'));
  });

  it('data null → ninguna', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useOperacionCancelacionVigente('u-1'));
    await waitFor(() => expect(result.current.estado).toBe('ninguna'));
  });

  it('error del RPC → error, NUNCA ninguna', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useOperacionCancelacionVigente('u-1'));
    await waitFor(() => expect(result.current.estado).toBe('error'));
  });

  it('promesa rechazada (fallo de red) → error', async () => {
    rpcMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useOperacionCancelacionVigente('u-1'));
    await waitFor(() => expect(result.current.estado).toBe('error'));
  });

  it('refetch() vuelve a consultar', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useOperacionCancelacionVigente('u-1'));
    await waitFor(() => expect(result.current.estado).toBe('ninguna'));
    expect(rpcMock).toHaveBeenCalledTimes(1);

    rpcMock.mockResolvedValue({ data: { operacion_id: 'op-2' }, error: null });
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.estado).toBe('en_curso'));
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('mientras en_curso, sondea sola (sin recarga manual)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rpcMock.mockResolvedValue({ data: { operacion_id: 'op-1' }, error: null });
    const { result } = renderHook(() => useOperacionCancelacionVigente('u-1'));
    await waitFor(() => expect(result.current.estado).toBe('en_curso'));
    expect(rpcMock).toHaveBeenCalledTimes(1);

    rpcMock.mockResolvedValue({ data: null, error: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(result.current.estado).toBe('ninguna');
  });
});
