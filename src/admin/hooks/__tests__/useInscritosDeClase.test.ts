import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Regresión (The Core, 8-oct): una reserva 'cancelada_admin' no tenía etiqueta
// en el modal de la clase → tronaba ("Algo salió mal") y no se podía cancelar
// la clase. El hook la normaliza a 'cancelada'.
const filas = [
  { id: 'r1', status: 'confirmada', folio: 'F1', lugar_id: null, invitados_count: 0, usuario: { id: 'u1', nombre: 'Ana', email: 'a@x', membresia_tier: null } },
  { id: 'r2', status: 'cancelada_admin', folio: 'F2', lugar_id: null, invitados_count: 0, usuario: { id: 'u2', nombre: 'Bea', email: 'b@x', membresia_tier: null } }
];

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const q: any = {
        select: () => q,
        eq: () => (tabla === 'reservas' ? q : Promise.resolve({ data: [], error: null })),
        order: () => Promise.resolve({ data: filas, error: null })
      };
      return q;
    }
  }
}));

import { useInscritosDeClase } from '../useInscritosDeClase';

describe('useInscritosDeClase', () => {
  it("normaliza 'cancelada_admin' a 'cancelada' (status que el modal sabe mostrar)", async () => {
    const { result } = renderHook(() => useInscritosDeClase('clase-1'));
    await waitFor(() => expect(result.current.inscritos).toHaveLength(2));
    expect(result.current.inscritos.map((i) => i.status)).toEqual(['confirmada', 'cancelada']);
  });
});
