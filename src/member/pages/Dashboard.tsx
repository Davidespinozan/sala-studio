import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';
import {
  claseFromRow,
  type Clase,
  type InstructorContext
} from '@member/logic/claseAdapter';
import { getTenantTimezone, hoyEnTimezone } from '@shared/lib/timezone';
import { ProximaClaseHero } from '@member/components/ProximaClaseHero';
import { ClaseCard } from '@member/components/ClaseCard';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];
type ClaseRow = Database['public']['Tables']['clases']['Row'];
type RecursoMinDB = Pick<Recurso, 'id' | 'nombre' | 'foto_url' | 'tiers_permitidos'>;

interface ClaseConRecurso extends ClaseRow {
  recurso: RecursoMinDB | null;
  instructor: InstructorContext | null;
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
          '*, clase:clases(*, recurso:recursos(id, nombre, foto_url, tiers_permitidos), instructor:instructores(id, nombre, foto_url))'
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
        setClase(mapClase(r.clase, count ?? 0, tz));
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

/** Clases de hoy desde la tabla `clases` real (S4.2). "Hoy" = tz del gym (S4.4). */
function useClasesDeHoy(tenantId: string, tz: string) {
  const [clases, setClases] = useState<Clase[]>([]);
  const [reservasMiembro, setReservasMiembro] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const { usuario } = useAuth();

  useEffect(() => {
    let mounted = true;
    async function load() {
      const fechaISO = hoyEnTimezone(tz);

      // S4.3: incluye canceladas para mostrarlas apagadas (transparencia al miembro).
      const clasesRes = await supabase
        .from('clases')
        .select(
          '*, recurso:recursos(id, nombre, foto_url, tiers_permitidos), instructor:instructores(id, nombre, foto_url)'
        )
        .eq('tenant_id', tenantId)
        .eq('fecha', fechaISO)
        .in('status', ['programada', 'cancelada'])
        .order('hora_inicio', { ascending: true });

      if (!mounted) return;

      if (clasesRes.error) {
        console.error('[Dashboard:clases]', clasesRes.error, { fechaISO, tenantId });
      }

      const filas = (clasesRes.data ?? []) as ClaseConRecurso[];
      const claseIds = filas.map((c) => c.id);

      const [cuposRes, misRes] = claseIds.length === 0
        ? [{ data: [] as Array<{ clase_id: string | null }> }, { data: [] as Array<{ clase_id: string | null }> }]
        : await Promise.all([
            supabase
              .from('reservas')
              .select('clase_id')
              .in('clase_id', claseIds)
              .in('status', ['confirmada', 'completada']),
            usuario
              ? supabase
                  .from('reservas')
                  .select('clase_id')
                  .eq('usuario_id', usuario.id)
                  .in('clase_id', claseIds)
                  .in('status', ['confirmada', 'completada'])
              : Promise.resolve({ data: [] as Array<{ clase_id: string | null }> })
          ]);

      if (!mounted) return;

      const cuposMap = new Map<string, number>();
      for (const r of (cuposRes.data ?? []) as Array<{ clase_id: string | null }>) {
        if (!r.clase_id) continue;
        cuposMap.set(r.clase_id, (cuposMap.get(r.clase_id) ?? 0) + 1);
      }
      const setMisReservas = new Set<string>();
      for (const r of (misRes.data ?? []) as Array<{ clase_id: string | null }>) {
        if (r.clase_id) setMisReservas.add(r.clase_id);
      }

      const ahora = Date.now();
      const futurasHoy = filas
        .map((row) => mapClase(row, cuposMap.get(row.id) ?? 0, tz))
        .filter((c) => c.slotInicio.getTime() >= ahora);

      setClases(futurasHoy);
      setReservasMiembro(setMisReservas);
      setIsLoading(false);
    }
    void load();
    return () => { mounted = false; };
  }, [tenantId, usuario, tz]);

  return { clases, reservasMiembro, isLoading };
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

  const {
    reserva: proximaReserva,
    clase: proximaClase,
    isLoading: loadingReserva
  } = useProximaReserva(usuario?.id);
  const { clases: clasesHoy, reservasMiembro, isLoading: loadingClases } = useClasesDeHoy(
    tenant.id,
    tz
  );

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
            border: '1px solid rgba(196, 74, 53, 0.3)',
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
            . Si tenés dudas, contactá a SALA.
          </p>
        </div>
      )}

      {/* Greeting */}
      <div style={{ marginBottom: '28px' }}>
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
        <section style={{ marginBottom: '40px' }}>
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
        <section style={{ marginBottom: '40px' }}>
          <ProximaClaseHero clase={proximaClase} reservaId={proximaReserva.id} />
        </section>
      ) : (
        <EmptyProximaClaseInline />
      )}

      {/* Clases de hoy */}
      <section style={{ marginBottom: '40px' }}>
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
            No hay más clases hoy. Mirá la{' '}
            <Link
              to="/app/reservar"
              style={{ color: 'var(--sala-primary)', fontWeight: 600, textDecoration: 'none' }}
            >
              agenda completa →
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
          <QuickAccessCard
            to="/app/perfil"
            label="Mi membresía"
            value={
              usuario?.membresia_tier
                ? `Plan ${capitalizarNombre(usuario.membresia_tier)}`
                : 'Sin plan activo'
            }
            icon="✦"
          />
          <QuickAccessCard
            to="/app/historial"
            label="Mis reservas"
            value="Ver historial"
            icon="◷"
          />
        </div>
      </section>

      {/* Onboarding pendiente */}
      {usuario?.status === 'pendiente_onboarding' && (
        <section
          style={{
            background: 'var(--sala-warning-bg)',
            border: '1px solid rgba(200, 148, 31, 0.3)',
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
          {linkLabel} →
        </Link>
      )}
    </div>
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
        No tenés clases reservadas.
      </span>{' '}
      Mirá las opciones de hoy ↓
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
  icon: string;
}) {
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
        <span
          aria-hidden="true"
          style={{
            fontSize: '14px',
            color: 'var(--sala-primary)',
            fontWeight: 700
          }}
        >
          {icon}
        </span>
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
