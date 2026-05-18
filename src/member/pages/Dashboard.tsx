import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';
import {
  clasesDelDia,
  reservaToClase,
  type RecursoMin,
  type Clase
} from '@member/logic/claseAdapter';
import { formatDateISO } from '@member/logic/reservaLogic';
import { ProximaClaseHero } from '@member/components/ProximaClaseHero';
import { ClaseCard } from '@member/components/ClaseCard';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];

interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre' | 'descripcion' | 'foto_url' | 'tipo_contenido' | 'tiers_permitidos'> | null;
}

// ============================================================================
// Hooks locales
// ============================================================================

/** Próxima reserva del miembro (con join completo del recurso para Clase adapter). */
function useProximaReserva(usuarioId: string | undefined) {
  const [reserva, setReserva] = useState<ReservaConRecurso | null>(null);
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
        .select('*, recurso:recursos(id, slug, nombre, descripcion, foto_url, tipo_contenido, tiers_permitidos)')
        .eq('usuario_id', usuarioId!)
        .eq('status', 'confirmada')
        .gte('slot_inicio', new Date().toISOString())
        .order('slot_inicio', { ascending: true })
        .limit(1);
      if (!mounted) return;
      setReserva(((data ?? [])[0] as unknown as ReservaConRecurso) ?? null);
      setIsLoading(false);
    }
    void load();
    return () => { mounted = false; };
  }, [usuarioId]);

  return { reserva, isLoading };
}

/** Clases de hoy: traversa todos los recursos activos y arma las Clase del día. */
function useClasesDeHoy(tenantId: string, duracionMin: number) {
  const [clases, setClases] = useState<Clase[]>([]);
  const [reservasMiembro, setReservasMiembro] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const { usuario } = useAuth();

  useEffect(() => {
    let mounted = true;
    async function load() {
      const hoy = new Date();
      const inicioDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
      const finDia = new Date(inicioDia.getTime() + 24 * 60 * 60 * 1000);
      const fechaISO = formatDateISO(inicioDia);

      const [recursosRes, reservasRes, misReservasRes] = await Promise.all([
        supabase
          .from('recursos')
          .select('id, nombre, descripcion, foto_url, tipo_contenido, tiers_permitidos, horarios')
          .eq('tenant_id', tenantId)
          .eq('activo', true),
        supabase
          .from('reservas')
          .select('recurso_id, slot_inicio')
          .eq('tenant_id', tenantId)
          .in('status', ['confirmada', 'completada'])
          .gte('slot_inicio', inicioDia.toISOString())
          .lt('slot_inicio', finDia.toISOString()),
        usuario
          ? supabase
              .from('reservas')
              .select('recurso_id, slot_inicio')
              .eq('usuario_id', usuario.id)
              .in('status', ['confirmada', 'completada'])
              .gte('slot_inicio', inicioDia.toISOString())
              .lt('slot_inicio', finDia.toISOString())
          : Promise.resolve({ data: [], error: null })
      ]);

      if (!mounted) return;

      const recursos = (recursosRes.data ?? []) as unknown as RecursoMin[];
      const reservasRaw = (reservasRes.data ?? []) as Array<{ recurso_id: string; slot_inicio: string }>;
      const misReservas = (misReservasRes.data ?? []) as Array<{ recurso_id: string; slot_inicio: string }>;

      const setMisReservas = new Set(
        misReservas.map((r) => `${r.recurso_id}_${new Date(r.slot_inicio).getTime()}`)
      );

      const clasesHoy = clasesDelDia(recursos, fechaISO, duracionMin, reservasRaw);
      // Filtrar solo las clases futuras del día (ya pasaron las anteriores)
      const ahora = Date.now();
      const futurasHoy = clasesHoy.filter((c) => c.slotInicio.getTime() >= ahora);

      setClases(futurasHoy);
      setReservasMiembro(setMisReservas);
      setIsLoading(false);
    }
    void load();
    return () => { mounted = false; };
  }, [tenantId, duracionMin, usuario]);

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

  const duracionDefaultMin = useMemo<number>(() => {
    const c = (tenant.config as Record<string, unknown> | null | undefined)?.reserva as
      | Record<string, unknown>
      | undefined;
    const v = c?.duracion_default_min;
    return typeof v === 'number' && v > 0 ? v : 60;
  }, [tenant.config]);

  const { reserva: proximaReserva, isLoading: loadingReserva } = useProximaReserva(usuario?.id);
  const { clases: clasesHoy, reservasMiembro, isLoading: loadingClases } = useClasesDeHoy(
    tenant.id,
    duracionDefaultMin
  );

  const ahora = new Date();
  const bloqueado = !!usuario?.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > ahora;
  const nombreFormat = capitalizarNombre(usuario?.nombre);

  const proximaClase = useMemo<Clase | null>(() => {
    if (!proximaReserva?.recurso) return null;
    return reservaToClase(
      proximaReserva,
      proximaReserva.recurso as RecursoMin
    );
  }, [proximaReserva]);

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
              agenda de mañana →
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
              const key = `${clase.recursoId}_${clase.slotInicio.getTime()}`;
              const ya = reservasMiembro.has(key);
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
