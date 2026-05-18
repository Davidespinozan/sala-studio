import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];

interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
}

// ============================================================================
// Hooks locales
// ============================================================================

function useRecursosActivos() {
  const tenant = useTenant();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('recursos')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('nombre');

      if (!mounted) return;
      if (error) console.error('[useRecursosActivos]', error);
      else setRecursos((data ?? []) as Recurso[]);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id]);

  return { recursos, isLoading };
}

function useProximasReservas(usuarioId: string | undefined) {
  const [reservas, setReservas] = useState<ReservaConRecurso[]>([]);

  useEffect(() => {
    if (!usuarioId) return;
    let mounted = true;
    async function load() {
      const { data } = await supabase
        .from('reservas')
        .select('*, recurso:recursos(id, nombre, slug)')
        .eq('usuario_id', usuarioId!)
        .eq('status', 'confirmada')
        .gte('slot_inicio', new Date().toISOString())
        .order('slot_inicio', { ascending: true })
        .limit(5);

      if (mounted) setReservas((data ?? []) as unknown as ReservaConRecurso[]);
    }
    load();
    return () => { mounted = false; };
  }, [usuarioId]);

  return { reservas };
}

// ============================================================================
// Helpers
// ============================================================================

function formatearFecha(iso: string): string {
  const d = new Date(iso);
  const fecha = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fecha} · ${hora}`;
}

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
  const { recursos } = useRecursosActivos();
  const { reservas: proximasReservas } = useProximasReservas(usuario?.id);

  const ahora = new Date();
  const bloqueado = usuario?.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > ahora;
  const nombreFormat = capitalizarNombre(usuario?.nombre) || 'creador';
  const proximaReserva = proximasReservas[0];

  return (
    <div className="ek-container">
      {bloqueado && (
        <div className="ek-card ek-card--md" style={{
          borderColor: 'rgba(226, 85, 85, 0.3)',
          background: 'var(--ek-danger-soft)',
          marginBottom: '24px'
        }}>
          <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)' }}>
            RESTRICCIÓN ACTIVA
          </p>
          <p className="ek-body" style={{ marginTop: '8px' }}>
            Podrás reservar nuevamente el{' '}
            <strong>
              {new Date(usuario!.bloqueado_hasta!).toLocaleDateString('es-MX', {
                weekday: 'long', day: 'numeric', month: 'long'
              })}
            </strong>.
          </p>
          <p className="ek-body-faint" style={{ marginTop: '8px' }}>
            Esto puede deberse a una inasistencia o suspensión. Contactá a EKKO si tienes dudas.
          </p>
        </div>
      )}

      {/* Greeting */}
      <div style={{ marginBottom: '28px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>BIENVENIDA</p>
        <h1 className="ek-display-xl">
          Hola, {nombreFormat}.
        </h1>
      </div>

      {/* Próxima sesión (hero) o empty state */}
      {proximaReserva ? (
        <div className="ek-card--hero" style={{ marginBottom: '24px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '14px' }}>
            PRÓXIMA SESIÓN
          </p>
          <h2 className="ek-display-lg" style={{ marginBottom: '6px' }}>
            {proximaReserva.recurso?.nombre ?? 'Estudio'}
          </h2>
          <p className="ek-body-muted" style={{ marginBottom: '14px' }}>
            {formatearFecha(proximaReserva.slot_inicio)}
          </p>
          <p className="ek-body-faint" style={{ marginBottom: '20px' }}>
            Folio: <span style={{ fontFamily: 'var(--ek-font-mono)' }}>
              {proximaReserva.folio}
            </span>
          </p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <Link to={`/app/qr/${proximaReserva.id}`} className="ek-cta">
              Ver QR <span style={{ color: 'var(--ek-mustard)' }}>→</span>
            </Link>
          </div>
        </div>
      ) : (
        <div className="ek-card" style={{ marginBottom: '24px', textAlign: 'center' }}>
          <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>
            SIN SESIONES AGENDADAS
          </p>
          <p className="ek-body" style={{ marginBottom: '20px' }}>
            Reserva tu próxima grabación.
          </p>
          <Link to="/app/reservar" className="ek-cta">
            Reservar ahora
          </Link>
        </div>
      )}

      {/* Onboarding pendiente */}
      {usuario?.status === 'pendiente_onboarding' && (
        <div className="ek-card ek-card--md" style={{
          borderColor: 'var(--ek-mustard-dim)',
          background: 'var(--ek-mustard-soft)',
          marginBottom: '24px'
        }}>
          <p className="ek-eyebrow ek-eyebrow--mustard">ONBOARDING PENDIENTE</p>
          <p className="ek-body" style={{ marginTop: '8px' }}>
            Aún no completas tu perfil ni activas tu membresía.
            (Esto se construye en el siguiente prompt.)
          </p>
        </div>
      )}

      {/* Estudios disponibles */}
      <div style={{ marginBottom: '16px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>EXPLORAR</p>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline'
        }}>
          <h2 className="ek-display-md">Estudios</h2>
          <Link
            to="/app/reservar"
            style={{
              fontSize: '11px',
              fontWeight: 700,
              color: 'var(--ek-mustard)',
              letterSpacing: '0.14em',
              textDecoration: 'none',
              textTransform: 'uppercase'
            }}
          >
            Ver todos →
          </Link>
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '12px'
      }}>
        {recursos.map((r) => {
          const esPro = r.tiers_permitidos.length === 1 && r.tiers_permitidos[0] === 'pro';
          return (
            <Link
              key={r.id}
              to="/app/reservar"
              className="ek-card ek-card-interactive"
              style={{
                padding: 0,
                overflow: 'hidden',
                textDecoration: 'none',
                color: 'inherit',
                borderRadius: 'var(--ek-r-md)'
              }}
            >
              <div style={{
                background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
                height: '120px',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <span
                  className={esPro ? 'ek-badge ek-badge--outline' : 'ek-badge'}
                  style={{ position: 'absolute', top: '10px', left: '10px' }}
                >
                  {esPro ? '★ PRO' : 'BÁSICA'}
                </span>
                <span style={{
                  fontSize: '9px',
                  color: 'var(--ek-ink-faint)',
                  letterSpacing: '0.18em',
                  fontWeight: 600
                }}>
                  FOTO PRÓXIMAMENTE
                </span>
              </div>

              <div style={{ padding: '14px' }}>
                <p style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '16px',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  margin: 0,
                  marginBottom: '4px'
                }}>{r.nombre}</p>
                {r.descripcion && (
                  <p style={{
                    fontSize: '11px',
                    color: 'var(--ek-ink-muted)',
                    margin: 0,
                    marginBottom: '10px'
                  }}>{r.descripcion}</p>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="ek-status-dot ek-status-dot--success" />
                  <span style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    letterSpacing: '0.12em',
                    color: 'var(--ek-success)'
                  }}>DISPONIBLE</span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
