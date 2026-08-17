import { useEffect, useRef } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';

/** Datos que arma el hook para pintar la pantalla de "CHECK-IN OK" (misma forma
 *  que devuelve qr-verify, para reusar CheckInDetail sin cambios). */
export interface HuellaCheckinData {
  reserva: {
    id: string; folio: string; slot_inicio: string; slot_fin: string;
    duracion_min: number; invitados_count: number; lugar_id: string | null;
  };
  miembro: {
    id: string; nombre: string | null; email: string; telefono: string | null;
    avatar_url: string | null; membresia_tier: string | null; notas_admin: string | null;
  };
  recurso: { id: string; nombre: string };
  membresia_estado?: string;
}

/**
 * Detecta check-ins por HUELLA y avisa para mostrar la pantalla del socio.
 *
 * El agente del lector marca el check-in en la base (check_in_por_huella) pero la
 * pantalla web no se entera sola. Este hook sondea cada ~2.5s las reservas recién
 * marcadas con `check_in_method='huella'` en ESTA sede y, cuando aparece una nueva
 * (posterior a abrir la pantalla), llama `onCheckIn` con los datos del socio.
 * Empieza mirando SOLO desde ahora, para no repintar entradas viejas al abrir.
 */
export function useHuellaCheckins(
  onCheckIn: (data: HuellaCheckinData) => void,
  enabled: boolean
) {
  const tenant = useTenant();
  const { sucursalId } = useReceptionSucursal();
  const desdeRef = useRef<string>(new Date().toISOString());
  const vistosRef = useRef<Set<string>>(new Set());
  const onRef = useRef(onCheckIn);
  onRef.current = onCheckIn;

  useEffect(() => {
    if (!enabled) return;
    let cancel = false;

    const tick = async () => {
      let q = supabase
        .from('reservas')
        .select(
          'id, folio, slot_inicio, slot_fin, duracion_min, invitados_count, lugar_id, check_in_at, ' +
          'usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, telefono, avatar_url, membresia_tier, notas_admin), ' +
          'recurso:recursos!inner(id, nombre, sucursal_id)'
        )
        .eq('tenant_id', tenant.id)
        .eq('status', 'completada')
        .eq('check_in_method', 'huella')
        .gte('check_in_at', desdeRef.current)
        .order('check_in_at', { ascending: false })
        .limit(1);
      if (sucursalId) q = q.eq('recurso.sucursal_id', sucursalId);

      const { data } = await q;
      if (cancel || !data || data.length === 0) return;

      const r = data[0] as unknown as {
        id: string; folio: string; slot_inicio: string; slot_fin: string;
        duracion_min: number; invitados_count: number | null; lugar_id: string | null;
        check_in_at: string;
        usuario: HuellaCheckinData['miembro'] | HuellaCheckinData['miembro'][] | null;
        recurso: { id: string; nombre: string } | { id: string; nombre: string }[] | null;
      };
      if (vistosRef.current.has(r.id)) return;
      vistosRef.current.add(r.id);
      if (r.check_in_at > desdeRef.current) desdeRef.current = r.check_in_at;

      const miembro = Array.isArray(r.usuario) ? r.usuario[0] : r.usuario;
      const recurso = Array.isArray(r.recurso) ? r.recurso[0] : r.recurso;
      if (!miembro || !recurso) return;

      onRef.current({
        reserva: {
          id: r.id, folio: r.folio, slot_inicio: r.slot_inicio, slot_fin: r.slot_fin,
          duracion_min: r.duracion_min, invitados_count: r.invitados_count ?? 0, lugar_id: r.lugar_id,
        },
        miembro,
        recurso: { id: recurso.id, nombre: recurso.nombre },
        membresia_estado: 'ok',
      });
    };

    const iv = setInterval(tick, 2500);
    void tick();
    return () => { cancel = true; clearInterval(iv); };
  }, [enabled, tenant.id, sucursalId]);
}
