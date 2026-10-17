import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regresión (numa, 17-oct): "Agregar miembro" desde la agenda abortaba en una
// clase VIRTUAL (0 inscritos) con el aviso "todavía no está activa". La RPC
// sí sabe materializar con horario + fecha (igual que Crear reserva en recepción).
const rpc = vi.fn();
vi.mock('@shared/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('@reception/lib/traducirErrorAccion', () => ({ translateActionError: (m: string) => m }));

import { inscribirMiembroManual } from '../useInscritosDeClase';

beforeEach(() => rpc.mockReset());

describe('inscribirMiembroManual', () => {
  it('clase virtual: manda horario + fecha y devuelve el clase_id materializado', async () => {
    rpc.mockResolvedValueOnce({ data: { success: true, reserva_id: 'r1', clase_id: 'c-nueva' }, error: null });
    const res = await inscribirMiembroManual({
      claseId: null, horarioId: 'h1', fecha: '2026-10-17', usuarioId: 'u1'
    });
    expect(rpc).toHaveBeenCalledWith('recepcion_crear_reserva', expect.objectContaining({
      p_usuario_id: 'u1', p_clase_id: null, p_horario_id: 'h1', p_fecha: '2026-10-17'
    }));
    expect(res).toEqual({ error: null, claseId: 'c-nueva' });
  });

  it('clase real: manda clase_id y NO horario/fecha', async () => {
    rpc.mockResolvedValueOnce({ data: { success: true, reserva_id: 'r1', clase_id: 'c1' }, error: null });
    const res = await inscribirMiembroManual({
      claseId: 'c1', horarioId: 'h1', fecha: '2026-10-17', usuarioId: 'u1'
    });
    expect(rpc).toHaveBeenCalledWith('recepcion_crear_reserva', expect.objectContaining({
      p_clase_id: 'c1', p_horario_id: null, p_fecha: null
    }));
    expect(res.claseId).toBe('c1');
  });

  it('error de la RPC: lo devuelve traducido y no hace check-in', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'SIN_CUPO' } });
    const res = await inscribirMiembroManual({ claseId: null, horarioId: 'h1', fecha: '2026-10-17', usuarioId: 'u1', checkInInmediato: true });
    expect(res.error).toBe('SIN_CUPO');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
