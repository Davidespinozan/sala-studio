import { useEffect, useState } from 'react';
import { ArrowRight, Check, CreditCard, Plus } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';
import { useMembresiaActual, membresiaEstado } from '@member/hooks/useMembresiaActual';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];
type Tier = Database['public']['Tables']['tiers']['Row'];

interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'nombre'> | null;
}

function useStatsDelMes(usuarioId: string | undefined) {
  const [sesionesEsteMes, setSesionesEsteMes] = useState(0);

  useEffect(() => {
    if (!usuarioId) return;
    let mounted = true;
    async function load() {
      const inicio = new Date();
      inicio.setDate(1);
      inicio.setHours(0, 0, 0, 0);

      const { count } = await supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('usuario_id', usuarioId!)
        .eq('status', 'completada')
        .gte('check_in_at', inicio.toISOString());

      if (mounted) setSesionesEsteMes(count ?? 0);
    }
    load();
    return () => { mounted = false; };
  }, [usuarioId]);

  return { sesionesEsteMes };
}

function useReservasPasadas(usuarioId: string | undefined) {
  const [reservas, setReservas] = useState<ReservaConRecurso[]>([]);

  useEffect(() => {
    if (!usuarioId) return;
    let mounted = true;
    async function load() {
      const { data } = await supabase
        .from('reservas')
        .select('*, recurso:recursos(nombre)')
        .eq('usuario_id', usuarioId!)
        .in('status', ['completada', 'cancelada', 'no_show'])
        .order('slot_inicio', { ascending: false })
        .limit(20);
      if (mounted) setReservas((data ?? []) as unknown as ReservaConRecurso[]);
    }
    load();
    return () => { mounted = false; };
  }, [usuarioId]);

  return { reservas };
}

function formatearFecha(iso: string): string {
  const d = new Date(iso);
  const fecha = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fecha} · ${hora}`;
}

function formatearFechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatearPrecio(centavos: number, moneda: string): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: moneda || 'MXN',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(centavos / 100);
}

/** Tiers activos del tenant, ordenados. Lectura vía RLS tiers_read_tenant. */
function useTiersDelTenant() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data } = await supabase
        .from('tiers')
        .select('*')
        .eq('activo', true)
        .order('orden', { ascending: true });
      if (mounted) {
        setTiers((data ?? []) as Tier[]);
        setIsLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, []);

  return { tiers, isLoading };
}


export default function Perfil() {
  const { authUser, usuario, signOut } = useAuth();
  const tenant = useTenant();
  const { reservas } = useReservasPasadas(usuario?.id);
  const { sesionesEsteMes } = useStatsDelMes(usuario?.id);
  const { membresia, isLoading: loadingMembresia } = useMembresiaActual(usuario?.id);
  const { tiers } = useTiersDelTenant();

  const nombreFormat = usuario?.nombre
    ?.toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') ?? '';

  const initials = (usuario?.nombre ?? usuario?.email ?? '?')
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">PERFIL</p>
          <h1 className="ek-display-md">{nombreFormat || 'Tu cuenta'}</h1>
        </div>

        {/* Avatar */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {usuario?.avatar_url ? (
            <img
              src={usuario.avatar_url}
              alt={usuario.nombre ?? 'Avatar'}
              style={{
                width: '120px',
                height: '120px',
                borderRadius: '50%',
                objectFit: 'cover',
                border: '0.5px solid var(--ek-line)'
              }}
            />
          ) : (
            <div style={{
              width: '120px',
              height: '120px',
              borderRadius: '50%',
              background: 'var(--ek-mustard)',
              color: 'var(--ek-bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--ek-font-display)',
              fontSize: '40px',
              fontWeight: 700,
              letterSpacing: '-0.04em'
            }}>
              {initials}
            </div>
          )}
        </div>

        <div className="adm-info-grid">
          <div className="adm-info-cell">
            <p className="adm-info-label">Email</p>
            <p className="adm-info-value">{authUser?.email}</p>
          </div>
          {usuario?.telefono && (
            <div className="adm-info-cell">
              <p className="adm-info-label">Teléfono</p>
              <p className="adm-info-value">{usuario.telefono}</p>
            </div>
          )}
          <div className="adm-info-cell">
            <p className="adm-info-label">Tenant</p>
            <p className="adm-info-value">{tenant.nombre}</p>
          </div>
          <div className="adm-info-cell">
            <p className="adm-info-label">Rol</p>
            <p className="adm-info-value adm-info-value--mono">{usuario?.rol}</p>
          </div>
          <div className="adm-info-cell">
            <p className="adm-info-label">Status</p>
            <p className="adm-info-value adm-info-value--mono">{usuario?.status}</p>
          </div>
        </div>

        {/* Plan: hero + método de pago + opciones + historial + cancelar + FAQ */}
        <PlanHero
          membresia={membresia}
          loading={loadingMembresia}
          tiers={tiers}
          tenantNombre={tenant.nombre}
        />
        <MetodoPago />
        <PlanActualYOpciones membresia={membresia} tiers={tiers} tenantNombre={tenant.nombre} />
        <HistorialPagos />
        {membresia && <CancelarSuscripcion tenantNombre={tenant.nombre} />}
        <FaqPlan />

        {/* Stat del mes */}
        <section style={{ marginTop: '32px', marginBottom: '24px' }}>
          <div className="ek-stat-card" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div>
              <p className="ek-eyebrow" style={{ marginBottom: '6px' }}>ESTE MES</p>
              <p className="ek-kpi">
                {sesionesEsteMes}{' '}
                <span style={{
                  fontSize: '15px',
                  fontWeight: 500,
                  color: 'var(--ek-ink-muted)',
                  letterSpacing: 'normal'
                }}>
                  {sesionesEsteMes === 1 ? 'sesión completada' : 'sesiones completadas'}
                </span>
              </p>
            </div>
          </div>
        </section>

        {/* Reservas pasadas */}
        <section>
          <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>HISTORIAL</p>
          <h2 className="ek-display-md" style={{ marginBottom: '16px' }}>Reservas pasadas</h2>

          {reservas.length === 0 ? (
            <p className="ek-body-muted">Aún no tenés sesiones completadas.</p>
          ) : (
            <div className="ek-stack-sm">
              {reservas.map((r) => (
                <div key={r.id} className="ek-card ek-card--md" style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{
                      fontFamily: 'var(--ek-font-display)',
                      fontSize: '14px',
                      fontWeight: 600,
                      letterSpacing: '-0.02em',
                      margin: 0
                    }}>
                      {r.recurso?.nombre ?? 'Sala'}
                    </p>
                    <p className="ek-body-faint" style={{ marginTop: '2px' }}>
                      {formatearFecha(r.slot_inicio)}
                    </p>
                  </div>
                  <span className={
                    r.status === 'completada' ? 'ek-badge ek-badge--success' :
                    r.status === 'cancelada' ? 'ek-badge ek-badge--neutral' :
                    'ek-badge ek-badge--danger'
                  }>
                    {r.status === 'completada' ? 'OK' :
                     r.status === 'cancelada' ? 'CANCELADA' :
                     'NO SHOW'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Cerrar sesión — al fondo */}
        <button
          onClick={signOut}
          className="ek-cta ek-cta--secondary ek-cta--full"
          style={{ marginTop: '8px' }}
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Mi suscripción
// ============================================================================

function PlanHero({
  membresia,
  loading,
  tiers,
  tenantNombre
}: {
  membresia: ReturnType<typeof useMembresiaActual>['membresia'];
  loading: boolean;
  tiers: Tier[];
  tenantNombre: string;
}) {
  const estado = membresiaEstado(membresia);
  const tierActual = membresia ? tiers.find((t) => t.id === membresia.tier_id) ?? null : null;
  const esCreditos = membresia?.tier_tipo === 'creditos' || membresia?.tier_tipo === 'hibrido';

  return (
    <section style={{ marginTop: '8px' }}>
      <div
        style={{
          borderRadius: 'var(--ek-r-card)',
          padding: '24px',
          background: 'linear-gradient(155deg, var(--sala-primary-darkest) 0%, var(--sala-neutral-dark) 100%)',
          boxShadow: '0 12px 32px rgba(10, 15, 12, 0.28)',
          overflow: 'hidden'
        }}
      >
        {loading ? (
          <div className="ek-skeleton" style={{ height: '76px', borderRadius: '12px', opacity: 0.35 }} />
        ) : membresia ? (
          <>
            <span
              style={{
                display: 'inline-block',
                padding: '5px 12px',
                borderRadius: '999px',
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.14)',
                color: 'rgba(255, 255, 255, 0.92)',
                fontSize: '11px',
                fontWeight: 800,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                marginBottom: '16px'
              }}
            >
              {membresia.tier_nombre}
            </span>

            <p
              style={{
                fontSize: '20px',
                fontWeight: 600,
                lineHeight: 1.35,
                color: 'rgba(255, 255, 255, 0.92)',
                margin: 0
              }}
            >
              {esCreditos ? (
                <>
                  Te quedan{' '}
                  <strong style={{ color: 'rgba(255, 255, 255, 0.97)', fontWeight: 800 }}>
                    {membresia.creditos_restantes ?? 0}{' '}
                    {(membresia.creditos_restantes ?? 0) === 1 ? 'clase' : 'clases'}
                  </strong>
                  .
                </>
              ) : membresia.periodo_actual_fin ? (
                <>
                  {estado === 'vencida' ? 'Tu plan venció el ' : 'Tu plan se renueva el '}
                  <strong style={{ color: 'rgba(255, 255, 255, 0.97)', fontWeight: 800 }}>
                    {formatearFechaCorta(membresia.periodo_actual_fin)}
                  </strong>
                  .
                </>
              ) : (
                'Tu plan está activo.'
              )}
            </p>

            {tierActual && (
              <p style={{ fontSize: '14px', color: 'rgba(255, 255, 255, 0.55)', margin: '10px 0 0' }}>
                {formatearPrecio(tierActual.precio_centavos, tierActual.moneda)}
              </p>
            )}
          </>
        ) : (
          <>
            <p style={{ fontSize: '20px', fontWeight: 600, color: 'rgba(255, 255, 255, 0.92)', margin: 0 }}>
              No tenés un plan activo
            </p>
            <p style={{ fontSize: '14px', color: 'rgba(255, 255, 255, 0.55)', margin: '8px 0 0', lineHeight: 1.5 }}>
              Hablá con {tenantNombre} para activar tu plan y empezar a reservar.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

// ============================================================================
// Plan actual y opciones
// ============================================================================

function PlanActualYOpciones({
  membresia,
  tiers,
  tenantNombre
}: {
  membresia: ReturnType<typeof useMembresiaActual>['membresia'];
  tiers: Tier[];
  tenantNombre: string;
}) {
  const toast = useToast();
  if (tiers.length === 0) return null;

  const avisarCambio = (nombre: string) =>
    toast.info(`Pronto vas a poder cambiar a ${nombre} desde acá. Por ahora, hablá con ${tenantNombre}.`);

  return (
    <section style={{ marginTop: '32px' }}>
      <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>PLAN ACTUAL Y OPCIONES</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
        {tiers.map((tier) => (
          <PlanOptionCard
            key={tier.id}
            tier={tier}
            esActual={membresia?.tier_id === tier.id}
            onCambiar={() => avisarCambio(tier.nombre)}
          />
        ))}
      </div>
    </section>
  );
}

function PlanOptionCard({
  tier,
  esActual,
  onCambiar
}: {
  tier: Tier;
  esActual: boolean;
  onCambiar: () => void;
}) {
  const beneficios = Array.isArray(tier.beneficios)
    ? (tier.beneficios as Array<{ label?: string; incluido?: boolean }>).filter(
        (b) => b && typeof b.label === 'string' && b.incluido !== false
      )
    : [];

  return (
    <div
      className="ek-card"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        border: esActual ? '2px solid var(--sala-primary)' : '1px solid var(--sala-border)',
        background: esActual ? 'var(--sala-primary-light)' : 'var(--sala-surface)'
      }}
    >
      {esActual && (
        <span
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            padding: '4px 10px',
            borderRadius: '999px',
            background: 'var(--sala-primary)',
            color: 'var(--sala-text-on-primary)',
            fontSize: '10px',
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase'
          }}
        >
          Actual
        </span>
      )}

      <h3
        style={{
          fontSize: '12px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--sala-text-secondary)',
          margin: 0
        }}
      >
        {tier.nombre}
      </h3>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '26px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: '6px 0 0',
          color: 'var(--sala-text-primary)'
        }}
      >
        {formatearPrecio(tier.precio_centavos, tier.moneda)}
      </p>

      {!esActual && beneficios.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: '14px 0 0',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '7px'
          }}
        >
          {beneficios.slice(0, 3).map((b, i) => (
            <li
              key={i}
              style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px', color: 'var(--sala-text-primary)' }}
            >
              <Check size={15} strokeWidth={2.5} style={{ color: 'var(--sala-primary)', flexShrink: 0, marginTop: '1px' }} />
              {b.label}
            </li>
          ))}
        </ul>
      )}

      {!esActual && (
        <button
          type="button"
          onClick={onCambiar}
          className="ek-cta ek-lift ek-cta--full"
          style={{ marginTop: 'auto', paddingTop: '12px', paddingBottom: '12px', fontSize: '13px' }}
        >
          Cambiar
          <ArrowRight size={15} strokeWidth={2.25} />
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Método de pago
// ============================================================================

function MetodoPago() {
  const toast = useToast();

  return (
    <section style={{ marginTop: '32px' }}>
      <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>MÉTODO DE PAGO</p>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: '14px',
          padding: '28px 20px',
          background: 'var(--sala-bg)',
          border: '1.5px dashed var(--sala-border-strong)',
          borderRadius: 'var(--ek-r-card)'
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '12px',
            background: 'var(--sala-primary-light)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <CreditCard size={22} strokeWidth={2} style={{ color: 'var(--sala-primary)' }} />
        </div>
        <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: 0 }}>
          No tenés una tarjeta guardada.
        </p>
        <button
          type="button"
          onClick={() => toast.info('Disponible pronto, cuando habilitemos los pagos en línea.')}
          className="ek-cta ek-lift ek-cta--full"
        >
          Agregar tarjeta
          <ArrowRight size={16} strokeWidth={2.25} />
        </button>
      </div>
    </section>
  );
}

// ============================================================================
// Historial de pagos
// ============================================================================

function HistorialPagos() {
  return (
    <section style={{ marginTop: '32px' }}>
      <p className="ek-eyebrow" style={{ marginBottom: '10px' }}>HISTORIAL DE PAGOS</p>
      <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: 0, lineHeight: 1.5 }}>
        Todavía no hay pagos. Van a aparecer acá cuando se habiliten los pagos en línea.
      </p>
    </section>
  );
}

// ============================================================================
// Cancelar suscripción
// ============================================================================

function CancelarSuscripcion({ tenantNombre }: { tenantNombre: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        toast.info(`Para cancelar tu plan, hablá con ${tenantNombre}. Pronto vas a poder hacerlo desde acá.`)
      }
      className="ek-cta ek-cta--secondary ek-cta--full"
      style={{ marginTop: '24px', color: 'var(--sala-text-secondary)' }}
    >
      Cancelar suscripción
    </button>
  );
}

// ============================================================================
// FAQ del plan
// ============================================================================

const FAQ_PLAN: Array<{ q: string; a: string }> = [
  {
    q: '¿Cuándo se hace el cobro?',
    a: 'Al renovar tu plan, en la fecha que ves arriba. Los pagos en línea estarán disponibles pronto.'
  },
  {
    q: '¿Qué pasa si cancelo?',
    a: 'Conservás el acceso hasta el final del período ya pagado. Después, tu plan no se renueva.'
  },
  {
    q: '¿Puedo cambiar de plan cuando quiera?',
    a: 'Sí. Por ahora coordinás el cambio con tu gimnasio; pronto vas a poder hacerlo desde acá.'
  },
  {
    q: '¿Cómo agrego o cambio mi tarjeta?',
    a: 'Desde "Método de pago", cuando habilitemos los pagos en línea.'
  }
];

function FaqPlan() {
  return (
    <section style={{ marginTop: '32px' }}>
      <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>PREGUNTAS FRECUENTES</p>
      <div className="ek-stack-sm">
        {FAQ_PLAN.map((f) => (
          <FaqItem key={f.q} q={f.q} a={f.a} />
        ))}
      </div>
    </section>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ek-card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '16px 18px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>{q}</span>
        <Plus
          size={18}
          strokeWidth={2.25}
          style={{
            flexShrink: 0,
            color: 'var(--sala-accent)',
            transition: 'transform 0.2s ease',
            transform: open ? 'rotate(45deg)' : 'rotate(0deg)'
          }}
        />
      </button>
      {open && (
        <p
          style={{
            fontSize: '13px',
            color: 'var(--sala-text-secondary)',
            lineHeight: 1.55,
            margin: 0,
            padding: '0 18px 16px'
          }}
        >
          {a}
        </p>
      )}
    </div>
  );
}
