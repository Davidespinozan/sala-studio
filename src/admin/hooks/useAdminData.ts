import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '@admin/providers/SucursalProvider';
import { backendPost } from '@shared/lib/backend';
import type { Database } from '@shared/types/database';
import type { SalaLayout } from '@shared/lib/salaLayout';

import { COLUMNAS_USUARIO_CLIENTE } from '@shared/lib/usuariosSelect';

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
      .select(COLUMNAS_USUARIO_CLIENTE)
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
    setMiembros((data as unknown as Usuario[]) ?? []);
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
    try {
      const [m, r] = await Promise.all([
        supabase.from('usuarios').select(COLUMNAS_USUARIO_CLIENTE).eq('id', miembroId).maybeSingle(),
        supabase
          .from('reservas')
          .select('*, recurso:recursos(id, slug, nombre)')
          .eq('usuario_id', miembroId)
          .order('slot_inicio', { ascending: false })
          .limit(50)
      ]);
      setMiembro((m.data as unknown as Usuario | null) ?? null);
      setReservas((r.data ?? []) as unknown as ReservaConJoin[]);
    } catch (err) {
      console.error('[useMiembroDetalle]', err);
    } finally {
      setIsLoading(false);
    }
  }, [miembroId]);

  useEffect(() => { refetch(); }, [refetch]);
  return { miembro, reservas, isLoading, refetch };
}

/**
 * Actualizar campos de un miembro. RLS valida que solo admin del tenant puede.
 * NO incluye membresia_tier/membresia_activa_id a propósito: el plan se cambia
 * SOLO por gestionar_membresia_socio (crea la fila de membresía + el ledger);
 * un UPDATE directo a usuarios.membresia_tier desincronizaría el cache.
 */
export async function updateMiembro(
  miembroId: string,
  patch: Partial<Pick<Usuario, 'rol' | 'status' | 'nombre' | 'telefono'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('usuarios').update(patch).eq('id', miembroId);
  return { error: error?.message ?? null };
}

/**
 * Recursos de la sucursal activa (admin ve todos, incluso inactivos).
 */
export function useRecursosAdmin() {
  const tenant = useTenant();
  const { sucursalId } = useSucursal();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!sucursalId) {
      setRecursos([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const { data, error } = await supabase
      .from('recursos')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('sucursal_id', sucursalId)
      .order('orden', { ascending: true });
    if (error) {
      console.error('[useRecursosAdmin]', error);
      setIsLoading(false);
      return;
    }
    setRecursos(data ?? []);
    setIsLoading(false);
  }, [tenant.id, sucursalId]);

  useEffect(() => { refetch(); }, [refetch]);
  return { recursos, isLoading, refetch };
}

export async function updateRecurso(
  recursoId: string,
  patch: Partial<Pick<Recurso,
    | 'nombre'
    | 'descripcion'
    | 'tiers_permitidos'
    | 'activo'
    | 'orden'
    | 'cupos'
    | 'cupo_max_default'
    | 'foto_url'
    | 'capacidad_personas'
    | 'tipo_contenido'
    | 'equipo_incluido'
    | 'estilo_visual'
    | 'intensidad'
    | 'destacado'
  >>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('recursos').update(patch).eq('id', recursoId);
  return { error: error?.message ?? null };
}

/**
 * Guarda (o quita) el Mapa de Salón de una sala. `layout` aún no está en los
 * tipos generados → cast. Al guardar un mapa, sincroniza `cupo_max_default` con
 * la cantidad de lugares (con mapa, el cupo = nº de lugares).
 */
export async function updateRecursoLayout(
  recursoId: string,
  layout: SalaLayout | null
): Promise<{ error: string | null }> {
  const patch: Record<string, unknown> = { layout };
  if (layout) patch.cupo_max_default = Math.max(1, layout.lugares.length);
  const { error } = await supabase.from('recursos').update(patch as never).eq('id', recursoId);
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
  patch: Partial<Pick<Tier, 'nombre' | 'descripcion' | 'precio_centavos' | 'inscripcion_centavos' | 'invitados_por_periodo' | 'moneda' | 'periodo' | 'tipo' | 'clases_incluidas' | 'duracion_dias' | 'beneficios' | 'reglas' | 'activo' | 'orden' | 'slug' | 'acceso_todas_sucursales'>>
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
      // try/finally: una query que rechace no debe dejar las métricas colgadas.
      try {
      const now = new Date();
      const inicioHoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const finHoy = new Date(inicioHoy.getTime() + 24 * 60 * 60 * 1000);
      const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
      const hace7d = new Date(inicioHoy.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [activos, total, hoy, mes, noShows, reservas7d, proximas, capHorarios] = await Promise.all([
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
          .limit(5),
        // Capacidad semanal real (nada hardcodeado): horarios activos del tenant.
        supabase
          .from('horarios_recurrentes')
          .select('cupo_max, dias_semana, recurso:recursos(cupo_max_default, activo)')
          .eq('tenant_id', tenant.id)
          .eq('activo', true)
      ]);

      if (!mounted) return;

      // Capacidad/semana = Σ (cupo × días que corre) sobre horarios activos de
      // salas activas. Una ventana de 7 días cubre cada día de semana una vez,
      // así que esto es la capacidad semanal exacta de la grilla.
      const capacidadSemanal = (
        (capHorarios.data ?? []) as Array<{
          cupo_max: number | null;
          dias_semana: number[] | null;
          recurso: { cupo_max_default: number | null; activo: boolean } | null;
        }>
      )
        .filter((h) => h.recurso?.activo)
        .reduce(
          (sum, h) =>
            sum + (h.cupo_max ?? h.recurso?.cupo_max_default ?? 0) * (h.dias_semana?.length ?? 0),
          0
        );
      const ocupacion7d = capacidadSemanal > 0
        ? Math.round(((reservas7d.count ?? 0) / capacidadSemanal) * 100)
        : 0;

      setMetrics({
        miembrosActivos: activos.count ?? 0,
        miembrosTotal: total.count ?? 0,
        reservasHoy: hoy.count ?? 0,
        reservasEsteMes: mes.count ?? 0,
        noShowsMes: noShows.count ?? 0,
        ocupacion7d,
        proximasReservas: (proximas.data ?? []) as unknown as ReservaConJoin[]
      });
      } catch (err) {
        console.error('[useAdminMetrics]', err);
      } finally {
        setIsLoading(false);
      }
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

    // try/finally: si una query rechaza (ej. caída de red), igual liberamos el
    // loading en vez de dejar el dashboard colgado para siempre.
    try {
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
    } catch (err) {
      console.error('[useAdminData] dashboard refetch error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, refetch };
}

/**
 * Reservas en un rango de fechas para vista calendario. Excluye canceladas
 * (cancelada / cancelada_admin) y, si se pasa sucursalId, scopea a esa sucursal
 * (vía la sala de la reserva) — antes mezclaba todas las sedes e incluía
 * canceladas, inflando la ocupación visible.
 */
export function useReservasRango(fechaInicio: Date, fechaFin: Date, sucursalId?: string | null) {
  const tenant = useTenant();
  const [reservas, setReservas] = useState<ReservaConJoin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Primitivos estables: los callers pasan objetos Date nuevos cada render,
  // depender del objeto causaría refetch en loop.
  const inicioMs = fechaInicio.getTime();
  const finMs = fechaFin.getTime();

  const refetch = useCallback(async () => {
    setIsLoading(true);
    let query = supabase
      .from('reservas')
      .select('*, recurso:recursos!inner(id, slug, nombre, sucursal_id), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)')
      .eq('tenant_id', tenant.id)
      .not('status', 'in', '(cancelada,cancelada_admin)')
      .gte('slot_inicio', new Date(inicioMs).toISOString())
      .lt('slot_inicio', new Date(finMs).toISOString())
      .order('slot_inicio', { ascending: true });

    if (sucursalId) query = query.eq('recurso.sucursal_id', sucursalId);

    const { data, error } = await query;

    if (error) {
      console.error('[useReservasRango]', error);
      setIsLoading(false);
      return;
    }
    setReservas((data ?? []) as unknown as ReservaConJoin[]);
    setIsLoading(false);
  }, [tenant.id, inicioMs, finMs, sucursalId]);

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
  /** Sede asignada (recepcionista en gym multisede). */
  sucursal_id?: string | null;
}

export interface CreateUserResponse {
  success: boolean;
  user: {
    id: string;
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

/**
 * Resultado del RPC gestionar_membresia_socio (Fase 4).
 * El RPC devuelve esto en el jsonb de respuesta.
 */
export interface GestionarMembresiaResult {
  success: boolean;
  membresia_id: string;
  modo: 'alta' | 'renovacion' | 'renovacion_desde_hoy' | 'cambio_de_tipo';
  tier_slug: string;
  tier_nombre: string;
  tier_tipo: 'tiempo' | 'creditos' | 'hibrido';
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
  delta_creditos: number;
}

/**
 * Alta / renovación / recarga / cambio de tipo manual de la membresía de un
 * socio. Wrapper del RPC gestionar_membresia_socio (Fase 4). Solo staff
 * (admin/recepción) del tenant del socio puede llamarlo — el RPC lo enforce.
 * Para detalle de la lógica suma/reset, ver el comment del RPC.
 */
export async function gestionarMembresiaSocio(params: {
  usuario_id: string;
  tier_id: string;
  motivo?: string;
}): Promise<{ data: GestionarMembresiaResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('gestionar_membresia_socio', {
    p_usuario_id: params.usuario_id,
    p_tier_id: params.tier_id,
    p_motivo: params.motivo
  });
  if (error) return { data: null, error: error.message };
  return { data: data as unknown as GestionarMembresiaResult, error: null };
}

/** Da de baja la membresía activa del socio (recepcion_cancelar_membresia):
 *  status='cancelada' + limpia el cache de plan en usuarios. El acceso queda
 *  bloqueado. Requiere motivo. */
export async function recepcionCancelarMembresia(params: {
  usuario_id: string;
  motivo: string;
}): Promise<{ error: string | null }> {
  // RPC no incluido aún en los tipos generados de Supabase.
  const { error } = await supabase.rpc('recepcion_cancelar_membresia' as never, {
    p_usuario_id: params.usuario_id,
    p_motivo: params.motivo
  } as never);
  return { error: error ? error.message : null };
}

/** Hard delete real vía auth.admin.deleteUser (libera el email para re-uso).
 *
 *  Devuelve envelope `{ data, error }` (no usa backendPost para poder
 *  exponer el body del 409 con `reservas_count` y orientar al admin a usar
 *  "Revocar acceso" en lugar de eliminar.
 *
 *  Errores comunes:
 *   - 403 último admin / auto-delete / cross-tenant
 *   - 409 tiene reservas en historial (con reservas_count)
 *   - 400 usuarioId inválido
 */
export interface AdminDeleteError {
  status: number;
  error: string;
  reservas_count?: number;
}

export async function adminDeleteUser(params: { usuarioId: string }): Promise<
  | { data: { success: true; email: string }; error: null }
  | { data: null; error: AdminDeleteError }
> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

  const res = await fetch('/.netlify/functions/admin-delete-user', {
    method: 'POST',
    headers,
    body: JSON.stringify(params)
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    return {
      data: null,
      error: {
        status: res.status,
        error: (body as { error?: string }).error ?? `Error HTTP ${res.status}`,
        reservas_count: (body as { reservas_count?: number }).reservas_count
      }
    };
  }

  return { data: body as { success: true; email: string }, error: null };
}
