import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { translateReadError } from '../lib/traducirErrorLectura';

/** Estado de membresía mapeado a las 4 variantes visuales de la ficha. */
export type EstadoMembresia = 'activa' | 'pausada' | 'vencida' | 'sin_plan';

export interface FichaMembresia {
  status: string;
  estado: EstadoMembresia;
  periodoFin: string | null;       // ISO; vence (membresias.periodo_actual_fin)
  creditos: number | null;          // null = plan por tiempo (ilimitado)
  tierId: string | null;            // para excluir el plan actual al cambiar
  tierNombre: string | null;
  tierTipo: string | null;          // 'tiempo' | 'creditos' | 'hibrido'
}

export interface FichaReserva {
  id: string;
  slot_inicio: string;
  slot_fin: string;
  recursoNombre: string | null;
}

export interface FichaAsistencia {
  semana: number;
  mes: number;
  pct: number | null;               // null si no hay historial (—)
}

export interface FichaSocio {
  id: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
  avatar_url: string | null;
  status: string;
  bloqueado_hasta: string | null;
  notas_admin: string | null;
  /** null = socio importado sin login todavía → se le puede "dar acceso". */
  auth_id: string | null;
}

export interface SocioFichaData {
  socio: FichaSocio;
  membresia: FichaMembresia | null;
  estado: EstadoMembresia;
  reservas: FichaReserva[];
  asistencia: FichaAsistencia;
}

// Shapes laxos para los joins (evita pelear con los tipos generados de supabase).
interface MembresiaQueryRow {
  status: string;
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
  tier: { id: string; nombre: string | null; tipo: string | null } | { id: string; nombre: string | null; tipo: string | null }[] | null;
}
interface ReservaQueryRow {
  id: string;
  slot_inicio: string;
  slot_fin: string;
  recurso: { nombre: string | null } | { nombre: string | null }[] | null;
}

function mapEstado(status: string | null | undefined): EstadoMembresia {
  if (!status) return 'sin_plan';
  if (status === 'congelada') return 'pausada';
  if (status === 'activa' || status === 'trialing' || status === 'past_due') return 'activa';
  if (status === 'expirada' || status === 'cancelada') return 'vencida';
  return 'sin_plan'; // 'pendiente' u otros → todavía sin plan usable
}

function unwrap<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Carga la ficha completa de un socio (read-only): datos, membresía + tier,
 * próximas reservas, asistencia (semana/mes/%), y notas. Expone refetch() para
 * refrescar después de una acción. Una guardia por request (reqIdRef) descarta
 * respuestas viejas (cambio de id o refetch concurrente).
 */
export function useSocioFicha(id: string | undefined) {
  const [data, setData] = useState<SocioFichaData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!id) return;
    const myReq = ++reqIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const { data: socioRow, error: e1 } = await supabase
        .from('usuarios')
        .select('id, nombre, email, telefono, avatar_url, status, bloqueado_hasta, notas_admin, auth_id')
        .eq('id', id)
        .maybeSingle();
      if (e1) throw e1;
      if (!socioRow) {
        if (reqIdRef.current === myReq) {
          setError('No encontramos ese socio.');
          setIsLoading(false);
        }
        return;
      }

      // Membresía más reciente (cualquier status) para conocer el estado real.
      const { data: memData } = await supabase
        .from('membresias')
        .select('status, periodo_actual_fin, creditos_restantes, tier:tiers(id, nombre, tipo)')
        .eq('usuario_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const mem = memData as MembresiaQueryRow | null;

      // Próximas reservas confirmadas.
      const nowISO = new Date().toISOString();
      const { data: reservasData } = await supabase
        .from('reservas')
        .select('id, slot_inicio, slot_fin, recurso:recursos(nombre)')
        .eq('usuario_id', id)
        .eq('status', 'confirmada')
        .gte('slot_inicio', nowISO)
        .order('slot_inicio', { ascending: true })
        .limit(5);

      // Asistencia: semana, mes, % (completadas / (completadas + no-shows)).
      const now = new Date();
      const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const dow = now.getDay();
      const backToMonday = dow === 0 ? 6 : dow - 1;
      const monday = new Date(now);
      monday.setDate(now.getDate() - backToMonday);
      monday.setHours(0, 0, 0, 0);
      const startWeek = monday.toISOString();

      const [semanaRes, mesRes, compRes, noShowRes] = await Promise.all([
        supabase.from('reservas').select('id', { count: 'exact', head: true })
          .eq('usuario_id', id).eq('status', 'completada').gte('slot_inicio', startWeek),
        supabase.from('reservas').select('id', { count: 'exact', head: true })
          .eq('usuario_id', id).eq('status', 'completada').gte('slot_inicio', startMonth),
        supabase.from('reservas').select('id', { count: 'exact', head: true })
          .eq('usuario_id', id).eq('status', 'completada'),
        supabase.from('reservas').select('id', { count: 'exact', head: true })
          .eq('usuario_id', id).eq('status', 'no_show'),
      ]);

      const comp = compRes.count ?? 0;
      const ns = noShowRes.count ?? 0;
      const pct = comp + ns > 0 ? Math.round((comp / (comp + ns)) * 100) : null;

      const tier = unwrap(mem?.tier);
      const membresia: FichaMembresia | null = mem
        ? {
            status: mem.status,
            estado: mapEstado(mem.status),
            periodoFin: mem.periodo_actual_fin,
            creditos: mem.creditos_restantes,
            tierId: tier?.id ?? null,
            tierNombre: tier?.nombre ?? null,
            tierTipo: tier?.tipo ?? null,
          }
        : null;

      const reservas: FichaReserva[] = ((reservasData ?? []) as ReservaQueryRow[]).map((r) => ({
        id: r.id,
        slot_inicio: r.slot_inicio,
        slot_fin: r.slot_fin,
        recursoNombre: unwrap(r.recurso)?.nombre ?? null,
      }));

      if (reqIdRef.current !== myReq) return; // respuesta vieja → descartar
      setData({
        socio: socioRow as FichaSocio,
        membresia,
        estado: membresia?.estado ?? 'sin_plan',
        reservas,
        asistencia: { semana: semanaRes.count ?? 0, mes: mesRes.count ?? 0, pct },
      });
      setIsLoading(false);
    } catch (err) {
      if (reqIdRef.current !== myReq) return;
      setError(translateReadError(err));
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, isLoading, error, refetch: load };
}
