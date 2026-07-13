import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';

export interface InvitadosBolsa {
  /** Pases que incluye el plan en cada periodo. 0 = el plan no permite invitados. */
  incluidos: number;
  /** Pases ya gastados en el periodo vigente. */
  usados: number;
  /** Los que le quedan al socio AHORA. Es el techo real de esta reserva. */
  disponibles: number;
}

const VACIA: InvitadosBolsa = { incluidos: 0, usados: 0, disponibles: 0 };

/**
 * Pases de invitado del socio en el periodo vigente.
 *
 * Antes esto era un techo POR CLASE (tiers.reglas.max_invitados): el socio podía
 * traer N invitados a CADA clase, sin tope acumulado. Ahora el plan da una BOLSA
 * por periodo (tiers.invitados_por_periodo) y la RPC invitados_disponibles es la
 * única fuente de verdad — la misma que valida reservar_clase_atomic, así que la
 * UI y el backend no pueden discrepar.
 */
export function useInvitadosDisponibles(): {
  bolsa: InvitadosBolsa;
  refetch: () => Promise<void>;
} {
  const { usuario } = useAuth();
  const [bolsa, setBolsa] = useState<InvitadosBolsa>(VACIA);

  const refetch = useCallback(async () => {
    if (!usuario?.id) { setBolsa(VACIA); return; }
    const { data, error } = await supabase.rpc('invitados_disponibles', {
      p_usuario_id: usuario.id
    });
    if (error || !data) { setBolsa(VACIA); return; }
    const d = data as unknown as Partial<InvitadosBolsa>;
    setBolsa({
      incluidos: d.incluidos ?? 0,
      usados: d.usados ?? 0,
      disponibles: d.disponibles ?? 0
    });
  }, [usuario?.id]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      await refetch();
      if (!mounted) return;
    })();
    return () => { mounted = false; };
  }, [refetch]);

  return { bolsa, refetch };
}

/**
 * Compat: los llamadores viejos solo querían "cuántos invitados puedo agregar".
 * Ahora eso es la bolsa DISPONIBLE, no un techo fijo por clase.
 */
export function useMaxInvitados(): number {
  return useInvitadosDisponibles().bolsa.disponibles;
}
