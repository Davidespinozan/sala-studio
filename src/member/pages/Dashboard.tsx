import { useEffect, useState } from 'react';
import { Activity, ArrowDown, ArrowRight, CalendarCheck, Clock, Heart, Sparkles, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { useMemberSucursal } from '@member/providers/MemberSucursalProvider';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';
import {
  claseFromRow,
  claseFromExpansion,
  type Clase,
  type ClaseExpansionRow,
  type InstructorContext
} from '@member/logic/claseAdapter';
import { getSucursalTimezone, getTenantTimezone, hoyEnTimezone } from '@shared/lib/timezone';
import { ProximaClaseHero } from '@member/components/ProximaClaseHero';
import { ClaseCard } from '@member/components/ClaseCard';
import { useMisListasEspera, type ListaEsperaItem } from '@member/hooks/useListaEspera';
import {
  useMembresiaActual,
  membresiaEstado,
  type MembresiaActual,
  type EstadoMembresia
} from '@member/hooks/useMembresiaActual';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];
type ClaseRow = Database['public']['Tables']['clases']['Row'];
type RecursoMinDB = Pick<Recurso, 'id' | 'nombre' | 'foto_url' | 'tiers_permitidos'>;

interface ClaseConRecurso extends ClaseRow {
  recurso: RecursoMinDB | null;
  instructor: InstructorContext | null;
  sucursal: { timezone: string } | null;
}

interface ReservaConClase extends Reserva {
  clase: ClaseConRecurso | null;
}

// ============================================================================
// Hooks locales
// ============================================================================

/** Próxima reserva del miembro + la clase joineada (S4.2: real). */
function useProximaReserva(usuarioId: string | undefined) {
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const [reserva, setReserva] = useState<ReservaConClase | null>(null);
  const [clase, setClase] = useState<Clase | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!usuarioId) {
      setIsLoading(false);
      return;
    }
    let mounted = true;
    async function load() {
      const { data } = await supabase
        .from('reservas')
        .select(
          '*, clase:clases(*, recurso:recursos(id, nombre, foto_url, tiers_permitidos), instructor:instructores(id, nombre, foto_url), sucursal:sucursales(timezone))'
        )
        .eq('usuario_id', usuarioId!)
        .eq('status', 'confirmada')
        .gte('slot_inicio', new Date().toISOString())
        .order('slot_inicio', { ascending: true })
        .limit(1);
      if (!mounted) return;

      const r = ((data ?? [])[0] as ReservaConClase | undefined) ?? null;
      setReserva(r);

      if (r?.clase) {
        // Cupos de esa clase para el hero
        const { count } = await supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('clase_id', r.clase.id)
          .in('status', ['confirmada', 'completada']);
        if (!mounted) return;
        setClase(
          mapClase(r.clase, count ?? 0, getSucursalTimezone(r.clase.sucursal?.timezone, tz))
        );
      } else {
        setClase(null);
      }
      setIsLoading(false);
    }
    void load();
    return () => { mounted = false; };
  }, [usuarioId, tz]);

  return { reserva, clase, isLoading };
}

/** Mapea una fila de clases (con recurso joineado) a la interfaz UI Clase. */
function mapClase(row: ClaseConRecurso, cuposReservados: number, tz: string): Clase {
  const recurso = row.recurso
    ? {
        id: row.recurso.id,
        nombre: row.recurso.nombre,
        foto_url: row.recurso.foto_url,
        tiers_permitidos: row.recurso.tiers_permitidos
      }
    : { id: row.recurso_id, nombre: '—' };
  return claseFromRow({ row, cuposReservados, recurso, instructor: row.instructor, tz });
}

/** Clases de hoy desde la tabla `clases` real (S4.2). "Hoy" = tz del gym (S4.4).
 *  Multi-sede: filtra por la sucursal activa del socio (null = todas). */
function useClasesDeHoy(tenantId: string, tz: string, sucursalId: string | null) {
  const [clases, setClases] = useState<Clase[]>([]);
  const [reservasMiembro, setReservasMiembro] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const { usuario } = useAuth();
  const usuarioId = usuario?.id;

  useEffect(() => {
    let mounted = true;
    async function load() {
      const fechaISO = hoyEnTimezone(tz);

      // Modelo virtual: expandir_clases trae las clases de hoy (virtuales +
      // materializadas) con cupos en `reservados`.
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string, args: Record<string, unknown>
      ) => Promise<{ data: ClaseExpansionRow[] | null; error: { message: string } | null }>;
      const { data, error } = await rpc('expandir_clases', {
        p_sucursal_id: sucursalId, p_desde: fechaISO, p_hasta: fechaISO
      });
      if (!mounted) return;
      if (error) console.error('[Dashboard:expandir_clases]', error, { fechaISO });

      const rows = (data ?? []) as ClaseExpansionRow[];
      const ahora = Date.now();
      const futurasHoy = rows
        .map((r) => claseFromExpansion(r, tz))
        .filter((c) => c.slotInicio.getTime() >= ahora)
        .sort((a, b) => a.slotInicio.getTime() - b.slotInicio.getTime());

      // Mis reservas de hoy (solo materializadas).
      const claseIds = rows.map((r) => r.clase_id).filter((x): x is string => !!x);
      const setMisReservas = new Set<string>();
      if (usuarioId && claseIds.length > 0) {
        const { data: misRes } = await supabase
          .from('reservas')
          .select('clase_id')
          .eq('usuario_id', usuarioId)
          .in('clase_id', claseIds)
          .in('status', ['confirmada', 'completada']);
        if (!mounted) return;
        for (const r of (misRes ?? []) as Array<{ clase_id: string | null }>) {
          if (r.clase_id) setMisReservas.add(r.clase_id);
        }
      }

      if (!mounted) return;
      setClases(futurasHoy);
      setReservasMiembro(setMisReservas);
      setIsLoading(false);
    }
    void load();
    return () => { mounted = false; };
    // usuarioId (no el objeto usuario): el objeto cambia de referencia en cada
    // re-hidratación del auth y disparaba re-fetches innecesarios.
  }, [tenantId, usuarioId, tz, sucursalId]);

  return { clases, reservasMiembro, isLoading };
}

/**
 * Resumen rápido del socio (chips de progreso del Home): cuántas reservas
 * próximas tiene y cuántas sesiones completó este mes. Datos del PROPIO socio
 * (no del tenant) → no hay nada que configurar en admin.
 */
function useResumenRapido(usuarioId: string | undefined) {
  const [proximas, setProximas] = useState(0);
  const [sesionesMes, setSesionesMes] = useState(0);
  const [favoritas, setFavoritas] = useState(0);

  useEffect(() => {
    if (!usuarioId) return;
    let mounted = true;
    async function load() {
      const inicioMes = new Date();
      inicioMes.setDate(1);
      inicioMes.setHours(0, 0, 0, 0);

      const [px, ses, fav] = await Promise.all([
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', usuarioId!)
          .eq('status', 'confirmada')
          .gte('slot_inicio', new Date().toISOString()),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', usuarioId!)
          .eq('status', 'completada')
          .gte('check_in_at', inicioMes.toISOString()),
        supabase
          .from('favoritos')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', usuarioId!)
      ]);

      if (!mounted) return;
      setProximas(px.count ?? 0);
      setSesionesMes(ses.count ?? 0);
      setFavoritas(fav.count ?? 0);
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [usuarioId]);

  return { proximas, sesionesMes, favoritas };
}

// ============================================================================
// Helpers
// ============================================================================

function capitalizarNombre(nombre: string | null | undefined): string {
  if (!nombre) return '';
  return nombre
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ============================================================================
// Dashboard
// ============================================================================

export default function Dashboard() {
  const { usuario } = useAuth();
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const { sucursalId } = useMemberSucursal();

  const {
    reserva: proximaReserva,
    clase: proximaClase,
    isLoading: loadingReserva
  } = useProximaReserva(usuario?.id);
  const { clases: clasesHoy, reservasMiembro, isLoading: loadingClases } = useClasesDeHoy(
    tenant.id,
    tz,
    sucursalId
  );
  const { items: listasEspera } = useMisListasEspera();
  const { proximas, sesionesMes, favoritas } = useResumenRapido(usuario?.id);

  const ahora = new Date();
  const bloqueado = !!usuario?.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > ahora;
  const nombreFormat = capitalizarNombre(usuario?.nombre);

  return (
    <div className="ek-container" style={{ paddingTop: '12px' }}>
      {/* Banner restricción */}
      {bloqueado && (
        <div
          style={{
            background: 'var(--sala-error-bg)',
            border: '1px solid var(--sala-error-glow)',
            borderRadius: '14px',
            padding: '14px 16px',
            marginBottom: '24px'
          }}
        >
          <p
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--sala-error)',
              margin: 0,
              marginBottom: '6px'
            }}
          >
            Restricción activa
          </p>
          <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
            Vas a poder reservar nuevamente el{' '}
            <strong>
              {new Date(usuario!.bloqueado_hasta!).toLocaleDateString('es-MX', {
                weekday: 'long', day: 'numeric', month: 'long'
              })}
            </strong>
            . Si tienes dudas, contacta a SALA.
          </p>
        </div>
      )}

      {/* Greeting */}
      <div style={{ marginBottom: '16px' }}>
        <h1
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(32px, 9vw, 44px)',
            fontWeight: 600,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            margin: 0,
            color: 'var(--sala-text-primary)'
          }}
        >
          {nombreFormat ? `Hola, ${nombreFormat}.` : 'Hola.'}
        </h1>
      </div>

      {/* Próxima clase (hero) o nudge compacto */}
      {loadingReserva ? (
        <section style={{ marginBottom: '26px' }}>
          <div
            style={{
              height: '200px',
              background: 'var(--sala-surface)',
              border: '1px solid var(--sala-border)',
              borderRadius: '20px'
            }}
          />
        </section>
      ) : proximaClase && proximaReserva ? (
        <section style={{ marginBottom: '26px' }}>
          <ProximaClaseHero clase={proximaClase} reservaId={proximaReserva.id} />
        </section>
      ) : (
        <EmptyProximaClaseInline />
      )}

      {/* Resumen rápido (chips de progreso) */}
      <section style={{ marginBottom: '26px' }}>
        <ResumenRapido proximas={proximas} sesionesMes={sesionesMes} favoritas={favoritas} />
      </section>

      {/* En lista de espera */}
      {listasEspera.length > 0 && (
        <section style={{ marginBottom: '26px' }}>
          <SectionHeader title="En lista de espera" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {listasEspera.map((item) => (
              <ListaEsperaCard key={item.lista_espera_id} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* Clases de hoy */}
      <section style={{ marginBottom: '26px' }}>
        <SectionHeader title="Clases de hoy" linkTo="/app/reservar" linkLabel="Ver todas" />
        {loadingClases ? (
          <SkeletonScrollRow />
        ) : clasesHoy.length === 0 ? (
          <p
            style={{
              fontSize: '14px',
              color: 'var(--sala-text-secondary)',
              padding: '12px 0 0',
              margin: 0
            }}
          >
            No hay más clases hoy. Mira la{' '}
            <Link
              to="/app/reservar"
              style={{ color: 'var(--sala-primary)', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              agenda completa
              <ArrowRight size={14} strokeWidth={2.25} />
            </Link>
          </p>
        ) : (
          <div
            style={{
              display: 'flex',
              gap: '12px',
              overflowX: 'auto',
              paddingBottom: '8px',
              scrollbarWidth: 'thin',
              scrollSnapType: 'x mandatory',
              marginInline: '-20px',
              paddingInline: '20px'
            }}
          >
            {clasesHoy.map((clase) => {
              const ya = reservasMiembro.has(clase.id);
              return (
                <div key={clase.id} style={{ scrollSnapAlign: 'start' }}>
                  <ClaseCard clase={clase} ya_reservada={ya} />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Accesos rápidos */}
      <section style={{ marginBottom: '24px' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '12px'
          }}
        >
          <MembresiaCard />
          <QuickAccessCard
            to="/app/historial"
            label="Mis reservas"
            value="Ver historial"
            icon={Clock}
          />
        </div>
      </section>

      {/* Onboarding pendiente */}
      {usuario?.status === 'pendiente_onboarding' && (
        <section
          style={{
            background: 'var(--sala-warning-bg)',
            border: '1px solid var(--sala-warning-glow)',
            borderRadius: '14px',
            padding: '14px 16px',
            marginBottom: '24px'
          }}
        >
          <p
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--sala-warning)',
              margin: 0,
              marginBottom: '6px'
            }}
          >
            Onboarding pendiente
          </p>
          <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
            Aún no completaste tu perfil ni activaste tu membresía.
          </p>
        </section>
      )}
    </div>
  );
}

// ============================================================================
// Sub-componentes locales
// ============================================================================

function SectionHeader({
  title,
  linkTo,
  linkLabel
}: {
  title: string;
  linkTo?: string;
  linkLabel?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: '14px'
      }}
    >
      <h2
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '20px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          margin: 0,
          color: 'var(--sala-text-primary)'
        }}
      >
        {title}
      </h2>
      {linkTo && linkLabel && (
        <Link
          to={linkTo}
          style={{
            fontSize: '12px',
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: 'var(--sala-primary)',
            textDecoration: 'none'
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            {linkLabel}
            <ArrowRight size={13} strokeWidth={2.25} />
          </span>
        </Link>
      )}
    </div>
  );
}

function ListaEsperaCard({ item }: { item: ListaEsperaItem }) {
  const fechaObj = new Date(`${item.fecha}T12:00:00`);
  const fechaLabel = fechaObj.toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
  const hora = item.hora_inicio.slice(0, 5);

  return (
    <Link
      to={`/app/clase/${item.clase_id}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '14px 16px',
        background: 'var(--sala-surface)',
        border: '1px dashed var(--sala-border-strong)',
        borderRadius: '14px',
        textDecoration: 'none',
        color: 'var(--sala-text-primary)'
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '15px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '2px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {item.nombre}
        </p>
        <p
          style={{
            fontSize: '12px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
            textTransform: 'capitalize',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {fechaLabel} · {hora}
        </p>
      </div>
      <span
        style={{
          flexShrink: 0,
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--sala-primary)',
          background: 'var(--sala-primary-light)',
          padding: '5px 10px',
          borderRadius: '999px',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        En espera #{item.posicion}
      </span>
    </Link>
  );
}

function EmptyProximaClaseInline() {
  return (
    <p
      style={{
        fontSize: '14px',
        color: 'var(--sala-text-secondary)',
        margin: 0,
        marginBottom: '24px',
        lineHeight: 1.5
      }}
    >
      <span
        style={{
          fontWeight: 700,
          color: 'var(--sala-text-primary)'
        }}
      >
        No tienes clases reservadas.
      </span>{' '}
      Mira las opciones de hoy
      <ArrowDown size={14} strokeWidth={2.25} style={{ display: 'inline', verticalAlign: 'text-bottom', marginLeft: '3px' }} />
    </p>
  );
}

function QuickAccessCard({
  to,
  label,
  value,
  icon
}: {
  to: string;
  label: string;
  value: string;
  icon: LucideIcon;
}) {
  const Icon = icon;
  return (
    <Link
      to={to}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '16px 18px',
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '14px',
        textDecoration: 'none',
        color: 'var(--sala-text-primary)',
        transition: 'border-color 0.18s ease, transform 0.12s ease'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Icon aria-hidden="true" size={16} strokeWidth={2.25} style={{ color: 'var(--sala-primary)' }} />
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--sala-text-tertiary)'
          }}
        >
          {label}
        </span>
      </div>
      <p
        style={{
          fontSize: '15px',
          fontWeight: 600,
          margin: 0,
          color: 'var(--sala-text-primary)'
        }}
      >
        {value}
      </p>
    </Link>
  );
}

function SkeletonScrollRow() {
  return (
    <div style={{ display: 'flex', gap: '12px', overflow: 'hidden' }}>
      {[1, 2, 3].map((n) => (
        <div
          key={n}
          className="ek-skeleton"
          style={{ width: '180px', height: '140px', flexShrink: 0, borderRadius: '16px' }}
        />
      ))}
    </div>
  );
}

// ============================================================================
// ResumenRapido — chips de progreso glanceables del Home
// ============================================================================

/**
 * Fila de chips de progreso del socio (Reservas próximas · Sesiones este mes ·
 * Membresía). Convierte el Home de "herramienta de reserva" a "tu progreso":
 * lo primero que ves al abrir. Usa tokens → se adapta a la marca del tenant.
 */
function ResumenRapido({
  proximas,
  sesionesMes,
  favoritas
}: {
  proximas: number;
  sesionesMes: number;
  favoritas: number;
}) {
  const { membresia } = useMembresiaActual();
  const estado = membresiaEstado(membresia);
  const memTexto =
    estado === 'sana'
      ? 'Activa'
      : estado === 'congelada'
        ? 'Pausada'
        : estado === 'vencida'
          ? 'Vencida'
          : estado === 'sin_creditos'
            ? 'Sin créditos'
            : 'Sin plan';

  const chips: { icon: LucideIcon; label: string; value: string }[] = [
    { icon: CalendarCheck, label: 'Próximas', value: `${proximas}` },
    { icon: Activity, label: 'Sesiones', value: `${sesionesMes}` },
    { icon: Sparkles, label: 'Membresía', value: memTexto },
    { icon: Heart, label: 'Favoritas', value: `${favoritas}` }
  ];

  return (
    <div style={{ display: 'flex', gap: '10px' }}>
      {chips.map((c) => {
        const Icon = c.icon;
        return (
          <div
            key={c.label}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '7px',
              padding: '14px 13px',
              background: 'var(--sala-surface)',
              border: '1px solid var(--sala-border)',
              borderRadius: '16px'
            }}
          >
            <Icon size={17} strokeWidth={2} style={{ color: 'var(--sala-primary)' }} />
            <span
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '16px',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
                color: 'var(--sala-text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {c.value}
            </span>
            <span
              style={{
                fontSize: '10.5px',
                fontWeight: 600,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: 'var(--sala-text-tertiary)'
              }}
            >
              {c.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// MembresiaCard — versión rica de la quick-access "Mi membresía"
// ============================================================================

/**
 * Tarjeta del dashboard que muestra el estado real de la membresía del socio.
 * Sustituye al texto plano "Plan Pro" que solo leía usuarios.membresia_tier.
 * El value cambia según tier.tipo (tiempo / creditos / hibrido) y el estado
 * derivado (vencida / sin créditos / pausada / sin membresía / sana).
 */
function MembresiaCard() {
  const { membresia, isLoading } = useMembresiaActual();

  if (isLoading) {
    return (
      <div
        className="ek-skeleton"
        style={{ height: '78px', borderRadius: '14px' }}
        aria-hidden="true"
      />
    );
  }

  const estado = membresiaEstado(membresia);
  const { value, problema } = membresiaCardTexto(membresia, estado);

  // Estado problemático → card neutra con borde/eyebrow tintados (no carnet).
  if (problema) {
    const eyebrowColor =
      estado === 'vencida' || estado === 'sin_membresia'
        ? 'var(--sala-error)'
        : 'var(--sala-warning)';
    const borderColor =
      estado === 'vencida' || estado === 'sin_membresia'
        ? 'var(--sala-error-glow)'
        : 'var(--sala-warning-glow)';
    return (
      <Link
        to="/app/perfil"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          height: '100%',
          padding: '16px 18px',
          background: 'var(--sala-surface)',
          border: `1px solid ${borderColor}`,
          borderRadius: '14px',
          textDecoration: 'none',
          color: 'var(--sala-text-primary)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sparkles aria-hidden="true" size={16} strokeWidth={2.25} style={{ color: eyebrowColor }} />
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: eyebrowColor
            }}
          >
            Mi membresía
          </span>
        </div>
        <p style={{ fontSize: '15px', fontWeight: 600, margin: 0, color: 'var(--sala-text-primary)', lineHeight: 1.35 }}>
          {value}
        </p>
      </Link>
    );
  }

  // Membresía sana → CARNET dorado (acento del tenant) con el nombre del plan.
  return (
    <Link
      to="/app/perfil"
      className="ek-lift"
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        height: '100%',
        padding: '16px 18px',
        borderRadius: '14px',
        background: 'var(--grad-accent)',
        border: '1px solid var(--sala-accent)',
        boxShadow:
          '0 8px 22px var(--sala-accent-dim), inset 0 1px 0 rgba(255, 255, 255, 0.28)',
        textDecoration: 'none',
        color: 'var(--sala-text-on-accent)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <Sparkles aria-hidden="true" size={14} strokeWidth={2.5} style={{ color: 'var(--sala-text-on-accent)', opacity: 0.85 }} />
        <span
          style={{
            fontSize: '10.5px',
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--sala-text-on-accent)',
            opacity: 0.82
          }}
        >
          Mi membresía
        </span>
      </div>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '19px',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          margin: 0,
          color: 'var(--sala-text-on-accent)',
          lineHeight: 1.1
        }}
      >
        {membresia?.tier_nombre ?? 'Plan'}
      </p>
      <p style={{ fontSize: '12.5px', fontWeight: 600, margin: 0, color: 'var(--sala-text-on-accent)', opacity: 0.84, lineHeight: 1.3 }}>
        {value}
      </p>
    </Link>
  );
}

/**
 * Texto humano para la tarjeta según tipo + estado. Pura, testeable desde
 * el helper exportado en el hook.
 */
export function membresiaCardTexto(
  m: MembresiaActual | null,
  estado: EstadoMembresia
): { value: string; problema: boolean } {
  if (estado === 'sin_membresia') return { value: 'Sin membresía activa', problema: true };
  if (estado === 'congelada') return { value: 'Membresía pausada', problema: true };
  // m no es null para los estados que siguen
  const fin = m?.periodo_actual_fin ? new Date(m.periodo_actual_fin) : null;
  const fechaCorta = fin
    ? fin.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })
    : null;

  if (estado === 'vencida') {
    return {
      value: fechaCorta ? `Vencida el ${fechaCorta}` : 'Vencida',
      problema: true
    };
  }

  if (estado === 'sin_creditos') {
    // Si es híbrido y tiene fecha, mostrarla para contexto.
    if (m?.tier_tipo === 'hibrido' && fechaCorta) {
      return { value: `Sin clases · hasta ${fechaCorta}`, problema: true };
    }
    return { value: 'Sin clases', problema: true };
  }

  // Estado sana — tres variantes según tipo
  const tipo = m?.tier_tipo ?? 'tiempo';
  const creditos = m?.creditos_restantes ?? 0;

  if (tipo === 'tiempo') {
    return {
      value: fechaCorta ? `Activa · vence ${fechaCorta}` : 'Activa',
      problema: false
    };
  }
  if (tipo === 'creditos') {
    return {
      value: creditos === 1 ? '1 clase restante' : `${creditos} clases restantes`,
      problema: false
    };
  }
  // hibrido
  return {
    value: fechaCorta
      ? `${creditos} ${creditos === 1 ? 'clase' : 'clases'} · hasta ${fechaCorta}`
      : `${creditos} ${creditos === 1 ? 'clase' : 'clases'}`,
    problema: false
  };
}
