import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@shared/lib/supabase', () => ({
  supabase: { from: vi.fn() }
}));

import { supabase } from '@shared/lib/supabase';
import { eliminarHorarioRecurrente, reservasQueQuedarianOcultas } from '../useHorariosRecurrentes';

type Mock = ReturnType<typeof vi.fn>;

describe('eliminarHorarioRecurrente', () => {
  beforeEach(() => vi.clearAllMocks());

  it('borra de horarios_recurrentes filtrando por id', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const del = vi.fn(() => ({ eq }));
    (supabase.from as Mock).mockReturnValue({ delete: del });

    const res = await eliminarHorarioRecurrente('hor-123');

    expect(supabase.from).toHaveBeenCalledWith('horarios_recurrentes');
    expect(del).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith('id', 'hor-123');
    expect(res.error).toBeNull();
  });

  it('NO toca la tabla clases — el delete del horario nunca borra clases', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    (supabase.from as Mock).mockReturnValue({ delete: () => ({ eq }) });

    await eliminarHorarioRecurrente('hor-123');

    // El borrado de un horario solo opera sobre horarios_recurrentes. Las
    // clases ya generadas las preserva la FK (ON DELETE SET NULL) del lado
    // de la base — la app nunca emite un DELETE contra `clases`.
    const tablasTocadas = (supabase.from as Mock).mock.calls.map((c) => c[0]);
    expect(tablasTocadas).toEqual(['horarios_recurrentes']);
    expect(tablasTocadas).not.toContain('clases');
  });

  it('propaga el mensaje de error de la BD (ej. RLS)', async () => {
    const eq = vi.fn().mockResolvedValue({ error: { message: 'permission denied' } });
    (supabase.from as Mock).mockReturnValue({ delete: () => ({ eq }) });

    const res = await eliminarHorarioRecurrente('hor-123');
    expect(res.error).toBe('permission denied');
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
