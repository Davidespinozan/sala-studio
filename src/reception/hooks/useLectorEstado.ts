import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useVisibilityAwarePolling } from '@shared/hooks/useVisibilityAwarePolling';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';

/** Igual que en Admin → Lectores: sin señal hace >10 min = desenchufado / agente caído. */
const VIVO_MS = 10 * 60 * 1000;

export type EstadoLector = 'conectado' | 'sin_senal' | 'sin_lector';

/**
 * Estado del lector de huella para RECEPCIÓN (son quienes lo usan). Se basa en
 * `lectores_biometricos.ultimo_visto_at`: el agente lo actualiza cada vez que le
 * habla al servidor. Fresco (<10 min) = conectado; viejo = sin señal; sin lector
 * dado de alta = sin_lector. Sondea cada 30s (se pausa en segundo plano).
 */
export function useLectorEstado(): EstadoLector {
  const { sucursalId } = useReceptionSucursal();
  const [estado, setEstado] = useState<EstadoLector>('sin_lector');

  const cargar = useCallback(async () => {
    const { data } = await supabase
      .from('lectores_biometricos')
      .select('ultimo_visto_at, sucursal_id')
      .eq('activo', true)
      .order('ultimo_visto_at', { ascending: false, nullsFirst: false });

    const filas = (data ?? []) as { ultimo_visto_at: string | null; sucursal_id: string | null }[];
    // El lector de esta sede (o uno global sin sede). Ya vienen del más reciente al más viejo.
    const relevantes = sucursalId
      ? filas.filter((f) => f.sucursal_id === sucursalId || f.sucursal_id === null)
      : filas;

    if (relevantes.length === 0) { setEstado('sin_lector'); return; }
    const uv = relevantes[0].ultimo_visto_at;
    setEstado(uv && Date.now() - new Date(uv).getTime() < VIVO_MS ? 'conectado' : 'sin_senal');
  }, [sucursalId]);

  useEffect(() => { void cargar(); }, [cargar]);
  useVisibilityAwarePolling(cargar, 30_000);

  return estado;
}
