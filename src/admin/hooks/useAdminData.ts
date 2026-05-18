import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { backendPost } from '@shared/lib/backend';
import type { Database } from '@shared/types/database';

type Usuario = Database['public']['Tables']['usuarios']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];
type Tier = Database['public']['Tables']['tiers']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];

export interface MiembroRow extends Usuario {
  reservas_count?: number;
}

export interface ReservaConJoin extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
  usuario: Pick<Usuario, 'id' | 'nombre' | 'email' | 'membresia_tier'> | null;
}

/**
 * Lista de miembros del tenant (sin paginación por simplicidad inicial).
 */
export function useMiembros(filtros?: { search?: string; status?: string; rol?: string | 'staff' }) {
  const tenant = useTenant();
  const [miembros, setMiembros] = useState<Usuario[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    let query = supabase
      .from('usuarios')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false });

    if (filtros?.status) query = query.eq('status', filtros.status);

    // Filtro especial "staff" = todos los no-miembros (recepcionista, staff, admin)
    if (filtros?.rol === 'staff') {
      query = query.in('rol', ['recepcionista', 'staff', 'admin']);
    } else if (filtros?.rol) {
      query = query.eq('rol', filtros.rol);
    }

    if (filtros?.search) {
      const term = `%${filtros.search}%`;
      query = query.or(`nombre.ilike.${term},email.ilike.${term}`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[useMiembros]', error);
      setIsLoading(false);
      return;
    }
    setMiembros(data ?? []);
    setIsLoading(false);
  }, [tenant.id, filtros?.search, filtros?.status, filtros?.rol]);

  useEffect(() => { refetch(); }, [refetch]);
  return { miembros, isLoading, refetch };
}

/**
 * Detalle de 1 miembro con sus reservas.
 */
export function useMiembroDetalle(miembroId: string | undefined) {
  const [miembro, setMiembro] = useState<Usuario | null>(null);
  const [reservas, setReservas] = useState<ReservaConJoin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!miembroId) return;
    setIsLoading(true);

    const [m, r] = await Promise.all([
      supabase.from('usuarios').select('*').eq('id', miembroId).maybeSingle(),
      supabase
        .from('reservas')
        .select('*, recurso:recursos(id, slug, nombre)')
        .eq('usuario_id', miembroId)
        .order('slot_inicio', { ascending: false })
        .limit(50)
    ]);

    setMiembro(m.data);
    setReservas((r.data ?? []) as unknown as ReservaConJoin[]);
    setIsLoading(false);
  }, [miembroId]);

  useEffect(() => { refetch(); }, [refetch]);
  return { miembro, reservas, isLoading, refetch };
}

/**
 * Actualizar campos arbitrarios de un miembro.
 * RLS valida que solo admin del tenant puede hacerlo.
 */
export async function updateMiembro(
  miembroId: string,
  patch: Partial<Pick<Usuario, 'rol' | 'status' | 'membresia_tier' | 'nombre' | 'telefono'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('usuarios').update(patch).eq('id', miembroId);
  return { error: error?.message ?? null };
}

/**
 * Recursos del tenant (admin ve todos, incluso inactivos).
 */
export function useRecursosAdmin() {
  const tenant = useTenant();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('recursos')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('orden', { ascending: true });
    if (error) {
      console.error('[useRecursosAdmin]', error);
      setIsLoading(false);
      return;
    }
    setRecursos(data ?? []);
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => { refetch(); }, [refetch]);
  return { recursos, isLoading, refetch };
}

export async function updateRecurso(
  recursoId: string,
  patch: Partial<Pick<Recurso,
    | 'nombre'
    | 'descripcion'
    | 'horarios'
    | 'tiers_permitidos'
    | 'activo'
    | 'orden'
    | 'cupos'
    | 'foto_url'
    | 'capacidad_personas'
    | 'tipo_contenido'
    | 'equipo_incluido'
    | 'estilo_visual'
  >>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('recursos').update(patch).eq('id', recursoId);
  return { error: error?.message ?? null };
}

export async function insertRecurso(
  payload: Database['public']['Tables']['recursos']['Insert']
): Promise<{ error: string | null; data: Recurso | null }> {
  const { data, error } = await supabase
    .from('recursos')
    .insert(payload)
    .select('*')
    .single();
  return { error: error?.message ?? null, data: (data as Recurso | null) ?? null };
}

/**
 * Tiers del tenant.
 */
export function useTiersAdmin() {
  const tenant = useTenant();
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('tiers')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('orden', { ascending: true });
    if (error) {
      console.error('[useTiersAdmin]', error);
      setIsLoading(false);
      return;
    }
    setTiers(data ?? []);
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => { refetch(); }, [refetch]);
  return { tiers, isLoading, refetch };
}

export async function updateTier(
  tierId: string,
  patch: Partial<Pick<Tier, 'nombre' | 'descripcion' | 'precio_centavos' | 'beneficios' | 'reglas' | 'activo' | 'orden' | 'slug'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('tiers').update(patch).eq('id', tierId);
  return { error: error?.message ?? null };
}

export async function insertTier(
  payload: Database['public']['Tables']['tiers']['Insert']
): Promise<{ error: string | null; data: Tier | null }> {
  const { data, error } = await supabase
    .from('tiers')
    .insert(payload)
    .select('*')
    .single();
  return { error: error?.message ?? null, data: (data as Tier | null) ?? null };
}

/**
 * Métricas del dashboard admin.
 */
export function useAdminMetrics() {
  const tenant = useTenant();
  const [metrics, setMetrics] = useState<{
    miembrosActivos: number;
    miembrosTotal: number;
    reservasHoy: number;
    reservasEsteMes: number;
    noShowsMes: number;
    ocupacion7d: number;
    proximasReservas: ReservaConJoin[];
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const now = new Date();
      const inicioHoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const finHoy = new Date(inicioHoy.getTime() + 24 * 60 * 60 * 1000);
      const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
      const hace7d = new Date(inicioHoy.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [activos, total, hoy, mes, noShows, reservas7d, proximas] = await Promise.all([
        supabase
          .from('usuarios')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .eq('rol', 'miembro')
          .eq('status', 'activo'),
        supabase
          .from('usuarios')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .eq('rol', 'miembro'),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .in('status', ['confirmada', 'completada'])
          .gte('slot_inicio', inicioHoy.toISOString())
          .lt('slot_inicio', finHoy.toISOString()),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .neq('status', 'cancelada')
          .gte('slot_inicio', inicioMes.toISOString()),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .eq('status', 'no_show')
          .gte('slot_inicio', inicioMes.toISOString()),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .neq('status', 'cancelada')
          .gte('slot_inicio', hace7d.toISOString())
          .lt('slot_inicio', inicioHoy.toISOString()),
        supabase
          .from('reservas')
          .select('*, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)')
          .eq('tenant_id', tenant.id)
          .eq('status', 'confirmada')
          .gte('slot_inicio', now.toISOString())
          .order('slot_inicio', { ascending: true })
          .limit(5)
      ]);

      if (!mounted) return;

      // 13 slots operativos × 3 estudios × 7 días = 273 slots disponibles/semana
      const SLOTS_DISPONIBLES_7D = 13 * 3 * 7;
      const ocupacion7d = Math.round(((reservas7d.count ?? 0) / SLOTS_DISPONIBLES_7D) * 100);

      setMetrics({
        miembrosActivos: activos.count ?? 0,
        miembrosTotal: total.count ?? 0,
        reservasHoy: hoy.count ?? 0,
        reservasEsteMes: mes.count ?? 0,
        noShowsMes: noShows.count ?? 0,
        ocupacion7d,
        proximasReservas: (proximas.data ?? []) as unknown as ReservaConJoin[]
      });
      setIsLoading(false);
    }

    load();
    return () => { mounted = false; };
  }, [tenant.id]);

  return { metrics, isLoading };
}

/**
 * Datos para Dashboard (Sprint Final).
 *
 * Devuelve métricas relevantes para 3 secciones del dashboard:
 *   - HOY: reservas del día con join a recurso/usuario
 *   - TU MES: 3 contadores (reservas, miembros nuevos, no-shows) con
 *     valores del mes anterior para calcular tendencia
 *   - GRAFICA: reservas por día en los últimos 30 días
 *
 * NO incluye datos de dinero — esos quedan deshabilitados hasta Stripe.
 */
export interface DashboardData {
  reservasHoy: ReservaConJoin[];
  reservasMesActual: number;
  reservasMesAnterior: number;
  miembrosNuevosMesActual: number;
  miembrosNuevosMesAnterior: number;
  noShowsMesActual: number;
  noShowsMesAnterior: number;
  totalReservasMesAnteriorParaNoShows: number;
  reservasUltimos30Dias: Array<{ fecha: string; count: number }>;
}

export function useDashboardData() {
  const tenant = useTenant();
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const now = new Date();
    const inicioHoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const finHoy = new Date(inicioHoy.getTime() + 24 * 60 * 60 * 1000);
    const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
    const inicioMesAnterior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const finMesAnterior = inicioMes;
    const hace30dias = new Date(inicioHoy.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      reservasHoy,
      reservasMesActual,
      reservasMesAnterior,
      miembrosMesActual,
      miembrosMesAnterior,
      noShowsActual,
      noShowsAnterior,
      reservasMesAnteriorTotales,
      reservas30d
    ] = await Promise.all([
      supabase
        .from('reservas')
        .select(
          '*, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)'
        )
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', inicioHoy.toISOString())
        .lt('slot_inicio', finHoy.toISOString())
        .order('slot_inicio', { ascending: true }),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', inicioMes.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', inicioMesAnterior.toISOString())
        .lt('slot_inicio', finMesAnterior.toISOString()),
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .gte('created_at', inicioMes.toISOString()),
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .gte('created_at', inicioMesAnterior.toISOString())
        .lt('created_at', finMesAnterior.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'no_show')
        .gte('slot_inicio', inicioMes.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'no_show')
        .gte('slot_inicio', inicioMesAnterior.toISOString())
        .lt('slot_inicio', finMesAnterior.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', inicioMesAnterior.toISOString())
        .lt('slot_inicio', finMesAnterior.toISOString()),
      supabase
        .from('reservas')
        .select('slot_inicio')
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', hace30dias.toISOString())
        .lt('slot_inicio', finHoy.toISOString())
    ]);

    // Agrupar reservas por día (YYYY-MM-DD)
    const conteoPorDia: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(hace30dias.getTime() + i * 24 * 60 * 60 * 1000);
      conteoPorDia[d.toISOString().slice(0, 10)] = 0;
    }
    (reservas30d.data ?? []).forEach((r) => {
      const k = String(r.slot_inicio).slice(0, 10);
      if (k in conteoPorDia) conteoPorDia[k]++;
    });
    const reservasUltimos30Dias = Object.entries(conteoPorDia).map(([fecha, count]) => ({
      fecha,
      count
    }));

    setData({
      reservasHoy: (reservasHoy.data ?? []) as unknown as ReservaConJoin[],
      reservasMesActual: reservasMesActual.count ?? 0,
      reservasMesAnterior: reservasMesAnterior.count ?? 0,
      miembrosNuevosMesActual: miembrosMesActual.count ?? 0,
      miembrosNuevosMesAnterior: miembrosMesAnterior.count ?? 0,
      noShowsMesActual: noShowsActual.count ?? 0,
      noShowsMesAnterior: noShowsAnterior.count ?? 0,
      totalReservasMesAnteriorParaNoShows: reservasMesAnteriorTotales.count ?? 0,
      reservasUltimos30Dias
    });
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, refetch };
}

/**
 * Reservas en un rango de fechas para vista calendario.
 */
export function useReservasRango(fechaInicio: Date, fechaFin: Date) {
  const tenant = useTenant();
  const [reservas, setReservas] = useState<ReservaConJoin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Primitivos estables: los callers pasan objetos Date nuevos cada render,
  // depender del objeto causaría refetch en loop.
  const inicioMs = fechaInicio.getTime();
  const finMs = fechaFin.getTime();

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('reservas')
      .select('*, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)')
      .eq('tenant_id', tenant.id)
      .gte('slot_inicio', new Date(inicioMs).toISOString())
      .lt('slot_inicio', new Date(finMs).toISOString())
      .order('slot_inicio', { ascending: true });

    if (error) {
      console.error('[useReservasRango]', error);
      setIsLoading(false);
      return;
    }
    setReservas((data ?? []) as unknown as ReservaConJoin[]);
    setIsLoading(false);
  }, [tenant.id, inicioMs, finMs]);

  useEffect(() => { refetch(); }, [refetch]);
  return { reservas, isLoading, refetch };
}

// ============================================================================
// Mutations de gestión de usuarios (vía Netlify Functions con service_role)
// ============================================================================

export interface CreateUserParams {
  email: string;
  password: string;
  nombre: string;
  telefono?: string;
  rol: 'miembro' | 'recepcionista' | 'staff' | 'admin';
  membresia_tier?: 'basica' | 'pro' | null;
}

export interface CreateUserResponse {
  success: boolean;
  user: {
    email: string;
    nombre: string;
    rol: string;
    password: string;
  };
}

export async function adminCreateUser(params: CreateUserParams) {
  return backendPost<CreateUserResponse>('admin-create-user', params);
}

export async function adminUpdateRole(params: {
  usuario_id: string;
  rol: 'miembro' | 'recepcionista' | 'staff' | 'admin';
}) {
  return backendPost<{ success: boolean }>('admin-update-role', params);
}
