import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@shared/lib/supabase', () => ({
  supabase: { from: vi.fn() }
}));

import { supabase } from '@shared/lib/supabase';
import { eliminarHorarioRecurrente } from '../useHorariosRecurrentes';

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
