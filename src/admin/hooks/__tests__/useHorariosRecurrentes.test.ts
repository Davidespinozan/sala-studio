import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@shared/lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() }
}));

import { supabase } from '@shared/lib/supabase';
import { eliminarHorarioRecurrente, reservasQueQuedarianOcultas } from '../useHorariosRecurrentes';

type Mock = ReturnType<typeof vi.fn>;

describe('eliminarHorarioRecurrente', () => {
  beforeEach(() => vi.clearAllMocks());

  it('borra vía el RPC atómico (no DELETE directo) y devuelve las clases conservadas', async () => {
    (supabase.rpc as Mock).mockResolvedValue({
      data: { ok: true, clases_borradas: 3, clases_conservadas: 2 },
      error: null
    });

    const res = await eliminarHorarioRecurrente('hor-123');

    expect(supabase.rpc).toHaveBeenCalledWith('eliminar_horario_recurrente', { p_horario_id: 'hor-123' });
    expect(res).toEqual({ error: null, clasesConservadas: 2 });
  });

  it('nunca emite un DELETE desde el navegador (ni a clases ni a horarios)', async () => {
    (supabase.rpc as Mock).mockResolvedValue({ data: { ok: true }, error: null });

    await eliminarHorarioRecurrente('hor-123');

    // Revisar reservas y borrar en dos llamadas dejaría una ventana donde una
    // reserva nueva se borraría en cascada (reservas.clase_id ON DELETE CASCADE).
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('propaga el mensaje de error de la BD (ej. NO_AUTORIZADO)', async () => {
    (supabase.rpc as Mock).mockResolvedValue({ data: null, error: { message: 'NO_AUTORIZADO: solo admin' } });

    const res = await eliminarHorarioRecurrente('hor-123');
    expect(res.error).toBe('NO_AUTORIZADO: solo admin');
    expect(res.clasesConservadas).toBe(0);
  });
});

describe('reservasQueQuedarianOcultas', () => {
  beforeEach(() => vi.clearAllMocks());

  // 2026-10-01 es JUEVES (dow 4). Clase del horario ya materializada.
  const clase = { id: 'c1', fecha: '2026-10-01', hora_inicio: '08:30:00', recurso_id: 'sala-a', status: 'programada' };
  const regla = { activo: true, recurso_id: 'sala-a', hora_inicio: '08:30', dias_semana: [4] };

  function mockTablas(clases: unknown[], reservas: number) {
    const reservasCount = vi.fn().mockResolvedValue({ count: reservas, error: null });
    (supabase.from as Mock).mockImplementation((tabla: string) => {
      if (tabla === 'clases') {
        const q = { select: () => q, eq: () => q, gte: () => q, neq: () => Promise.resolve({ data: clases, error: null }) };
        return q;
      }
      const q = { select: () => q, in: () => q, eq: reservasCount };
      return q;
    });
    return reservasCount;
  }

  it('sin cambios de sala/hora/días: 0 y ni siquiera cuenta reservas', async () => {
    const count = mockTablas([clase], 3);
    const r = await reservasQueQuedarianOcultas('h1', regla);
    expect(r).toEqual({ total: 0, error: null });
    expect(count).not.toHaveBeenCalled();
  });

  it('desactivar un horario con reservas futuras → las cuenta (bloquea)', async () => {
    mockTablas([clase], 3);
    const r = await reservasQueQuedarianOcultas('h1', { ...regla, activo: false });
    expect(r.total).toBe(3);
  });

  it('cambiar la sala, la hora o quitar el día → las cuenta', async () => {
    mockTablas([clase], 2);
    expect((await reservasQueQuedarianOcultas('h1', { ...regla, recurso_id: 'sala-b' })).total).toBe(2);
    expect((await reservasQueQuedarianOcultas('h1', { ...regla, hora_inicio: '09:00' })).total).toBe(2);
    expect((await reservasQueQuedarianOcultas('h1', { ...regla, dias_semana: [2] })).total).toBe(2);
  });

  it('agregar días sin quitar el de la clase → 0', async () => {
    mockTablas([clase], 2);
    expect((await reservasQueQuedarianOcultas('h1', { ...regla, dias_semana: [2, 4] })).total).toBe(0);
  });

  it('conteo de reservas ausente (null) → error, no 0 (fail-closed)', async () => {
    const reservasCount = vi.fn().mockResolvedValue({ count: null, error: null });
    (supabase.from as Mock).mockImplementation((tabla: string) => {
      if (tabla === 'clases') {
        const q = { select: () => q, eq: () => q, gte: () => q, neq: () => Promise.resolve({ data: [clase], error: null }) };
        return q;
      }
      const q = { select: () => q, in: () => q, eq: reservasCount };
      return q;
    });
    const r = await reservasQueQuedarianOcultas('h1', { ...regla, activo: false });
    expect(r.error).not.toBeNull();
  });

  it('error al leer clases → devuelve error (el formulario no guarda)', async () => {
    (supabase.from as Mock).mockImplementation(() => {
      const q = { select: () => q, eq: () => q, gte: () => q, neq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) };
      return q;
    });
    const r = await reservasQueQuedarianOcultas('h1', regla);
    expect(r.error).toBe('boom');
  });
});
