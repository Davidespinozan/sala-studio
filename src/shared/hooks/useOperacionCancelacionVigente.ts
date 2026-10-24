import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export type EstadoOperacionCancelacion = 'cargando' | 'ninguna' | 'en_curso' | 'error';

/**
 * Consulta `operacion_cancelacion_vigente` (BLOCK 2) para saber si hay una
 * cancelación/retiro Stripe en curso sobre una membresía. Un error de consulta
 * NUNCA se trata como "no hay operación pendiente" — devuelve 'error', para
 * que el caller bloquee nuevas acciones Stripe hasta poder reintentar (no
 * sabemos si hay una operación en vuelo o no).
 *
 * Mientras el estado es 'en_curso', reintenta sola cada 20s — así, cuando el
 * reconciliador (BLOCK 2B) resuelve la operación en segundo plano, la
 * interfaz termina reflejándolo sin que el usuario tenga que recargar. No
 * promete un tiempo fijo: el intervalo es de sondeo, no una garantía.
 *
 * @param usuarioId — dueño de la membresía a consultar (socio sobre sí mismo,
 *   o recepción sobre el socio que está viendo). La autorización real la hace
 *   el RPC (mismo patrón que el resto de BLOCK2): _guard_sucursal_recepcion.
 */
export function useOperacionCancelacionVigente(usuarioId: string | undefined) {
  const [estado, setEstado] = useState<EstadoOperacionCancelacion>('cargando');
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!usuarioId) {
      setEstado('ninguna');
      return;
    }
    let mounted = true;
    setEstado((prev) => (prev === 'error' || prev === 'cargando' ? 'cargando' : prev));
    Promise.resolve(
      supabase.rpc('operacion_cancelacion_vigente' as never, { p_usuario_id: usuarioId } as never)
    )
      .then(({ data, error }: { data: unknown; error: unknown }) => {
        if (!mounted) return;
        setEstado(error ? 'error' : data ? 'en_curso' : 'ninguna');
      })
      .catch(() => {
        if (mounted) setEstado('error');
      });
    return () => {
      mounted = false;
    };
  }, [usuarioId, nonce]);

  // Sondeo mientras hay una operación en curso: sin esto, la única forma de
  // ver que 2B ya la resolvió sería recargar la página a mano.
  useEffect(() => {
    if (estado !== 'en_curso') return;
    const id = setInterval(() => setNonce((n) => n + 1), 20000);
    return () => clearInterval(id);
  }, [estado]);

  return { estado, refetch };
}
