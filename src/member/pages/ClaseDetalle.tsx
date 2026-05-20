import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { supabase } from '@shared/lib/supabase';
import { crearReserva, cancelarReserva as cancelarReservaRPC } from '@member/hooks/useReservas';
import {
  claseFromRow,
  estadoCupos,
  formatHoraHumana,
  type Clase,
  type InstructorContext
} from '@member/logic/claseAdapter';
import type { Database } from '@shared/types/database';
import { CupoBar } from '@member/components/CupoBar';
import { ConfirmarReservaModal } from '@member/components/ConfirmarReservaModal';
import { ConfirmarCancelacionModal } from '@member/components/ConfirmarCancelacionModal';

type ClaseRow = Database['public']['Tables']['clases']['Row'];

interface RecursoFetched {
  id: string;
  nombre: string;
  descripcion: string | null;
  foto_url: string | null;
  tipo_contenido: string[] | null;
  tiers_permitidos: string[];
  capacidad_personas: number | null;
  equipo_incluido: string[] | null;
}

/** Emoji decorativo según disciplina, para placeholder cuando no hay foto. */
function emojiFor(disciplina: string): string {
  const d = disciplina.toLowerCase();
  if (d.includes('yoga') || d.includes('pilates') || d.includes('flow') || d.includes('stretch')) return '🧘';
  if (d.includes('spinning') || d.includes('cycling') || d.includes('bici') || d.includes('indoor')) return '🚴';
  if (d.includes('crossfit') || d.includes('hiit') || d.includes('funcional') || d.includes('fuerza')) return '💪';
  if (d.includes('baile') || d.includes('dance') || d.includes('zumba')) return '💃';
  if (d.includes('boxeo') || d.includes('box')) return '🥊';
  if (d.includes('correr') || d.includes('running')) return '🏃';
  return '✦';
}

function tierTieneAcceso(tiers: string[] | null | undefined, tier: string | null | undefined): boolean {
  if (!tier) return false;
  if (!tiers || tiers.length === 0) return true;
  return tiers.includes(tier);
}

export default function ClaseDetalle() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { usuario } = useAuth();
  const tenant = useTenant();
  const toast = useToast();

  // S4.2: el id de la URL es ahora el UUID directo de la fila en `clases`.
  const claseId = useMemo(() => {
    if (!id) return null;
    try {
      return decodeURIComponent(id);
    } catch {
      return null;
    }
  }, [id]);

  const [claseRow, setClaseRow] = useState<ClaseRow | null>(null);
  const [instructorCtx, setInstructorCtx] = useState<InstructorContext | null>(null);
  const [recurso, setRecurso] = useState<RecursoFetched | null>(null);
  const [cuposReservados, setCuposReservados] = useState(0);
  const [miReservaId, setMiReservaId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Modales
  const [showReservaModal, setShowReservaModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [invitados, setInvitados] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [errorReserva, setErrorReserva] = useState<string | null>(null);

  // Refresh tick
  const [refreshTick, setRefreshTick] = useState(0);
  const triggerRefresh = () => setRefreshTick((t) => t + 1);

  useEffect(() => {
    if (!claseId || !usuario) {
      if (!claseId) {
        setNotFound(true);
        setIsLoading(false);
      }
      return;
    }
    let mounted = true;
    setIsLoading(true);
    setNotFound(false);

    async function load() {
      // 1) Cargar la clase por UUID
      const claseRes = await supabase
        .from('clases')
        .select('*, instructor:instructores(id, nombre, foto_url, bio)')
        .eq('id', claseId!)
        .eq('tenant_id', tenant.id)
        .maybeSingle();

      if (!mounted) return;

      if (claseRes.error || !claseRes.data) {
        setNotFound(true);
        setIsLoading(false);
        return;
      }

      const data = claseRes.data as ClaseRow & { instructor: InstructorContext | null };
      const row = data as ClaseRow;

      // 2) Recurso + cupos + mi reserva en paralelo
      const [recursoRes, countRes, miRes] = await Promise.all([
        supabase
          .from('recursos')
          .select('id, nombre, descripcion, foto_url, tipo_contenido, tiers_permitidos, capacidad_personas, equipo_incluido')
          .eq('id', row.recurso_id)
          .eq('tenant_id', tenant.id)
          .maybeSingle(),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('clase_id', row.id)
          .in('status', ['confirmada', 'completada']),
        supabase
          .from('reservas')
          .select('id, status')
          .eq('usuario_id', usuario!.id)
          .eq('clase_id', row.id)
          .in('status', ['confirmada', 'completada'])
          .maybeSingle()
      ]);

      if (!mounted) return;

      if (recursoRes.error || !recursoRes.data) {
        setNotFound(true);
        setIsLoading(false);
        return;
      }

      setClaseRow(row);
      setInstructorCtx(data.instructor ?? null);
      setRecurso(recursoRes.data as RecursoFetched);
      setCuposReservados(countRes.count ?? 0);
      setMiReservaId((miRes.data as { id: string } | null)?.id ?? null);
      setIsLoading(false);
    }

    void load();
    return () => { mounted = false; };
  }, [claseId, usuario, tenant.id, refreshTick]);

  // Construir la Clase visual a partir de la fila real
  const clase = useMemo<Clase | null>(() => {
    if (!claseRow || !recurso) return null;
    return claseFromRow({
      row: claseRow,
      cuposReservados,
      recurso: {
        id: recurso.id,
        nombre: recurso.nombre,
        foto_url: recurso.foto_url,
        tiers_permitidos: recurso.tiers_permitidos
      },
      instructor: instructorCtx
    });
  }, [claseRow, recurso, cuposReservados, instructorCtx]);

  const tier = usuario?.membresia_tier ?? null;
  const puedeAccederTier = recurso ? tierTieneAcceso(recurso.tiers_permitidos, tier) : false;
  const yaReservada = !!miReservaId;
  const esFutura = clase ? clase.slotInicio.getTime() > Date.now() : false;
  const maxInvitados = tier === 'pro' ? 4 : tier === 'basica' ? 2 : 0;

  // === Handlers ===

  function handleBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate('/app/reservar');
  }

  function handleReservar() {
    if (!clase) return;
    const llena = clase.cuposReservados >= clase.cupoMax;
    if (llena) {
      toast.info('Lista de espera próximamente. Probá con otro horario por ahora.');
      return;
    }
    if (!puedeAccederTier) {
      toast.warning('Tu plan no incluye esta sala.');
      return;
    }
    if (!esFutura) {
      toast.error('Esta clase ya pasó.');
      return;
    }
    setErrorReserva(null);
    setInvitados(0);
    setShowReservaModal(true);
  }

  async function confirmarReserva() {
    if (!clase) return;
    setSubmitting(true);
    setErrorReserva(null);
    try {
      await crearReserva({
        claseId: clase.id,
        invitados,
        notas: undefined
      });
      setShowReservaModal(false);
      setSubmitting(false);
      toast.success('Reserva confirmada.');
      triggerRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error reservando';
      setErrorReserva(msg);
      setSubmitting(false);
    }
  }

  async function confirmarCancelacion() {
    if (!miReservaId) return;
    setSubmitting(true);
    const { error } = await cancelarReservaRPC({ reserva_id: miReservaId });
    setSubmitting(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success('Reserva cancelada.');
    setShowCancelModal(false);
    triggerRefresh();
  }

  // === Render ===

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', paddingBottom: '180px' }}>
        <BackButton onClick={handleBack} />
        <div className="ek-skeleton" style={{ aspectRatio: '16 / 9', borderRadius: 0, marginBottom: '24px' }} />
        <div className="ek-container">
          <div className="ek-skeleton" style={{ height: '60px', marginBottom: '16px' }} />
          <div className="ek-skeleton" style={{ height: '120px', marginBottom: '16px' }} />
        </div>
      </div>
    );
  }

  if (notFound || !clase || !recurso) {
    return (
      <div className="ek-container" style={{ paddingTop: '24px' }}>
        <BackButton onClick={handleBack} inline />
        <div style={{
          padding: '48px 20px',
          textAlign: 'center',
          marginTop: '24px',
          background: 'var(--sala-surface)',
          border: '1px solid var(--sala-border)',
          borderRadius: '14px'
        }}>
          <p style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--sala-text-tertiary)',
            margin: 0,
            marginBottom: '8px'
          }}>
            No encontrada
          </p>
          <h2 style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 600,
            margin: 0,
            marginBottom: '16px',
            color: 'var(--sala-text-primary)'
          }}>
            No encontramos esta clase.
          </h2>
          <Link
            to="/app/reservar"
            style={{
              display: 'inline-flex',
              padding: '12px 22px',
              minHeight: '44px',
              borderRadius: '999px',
              background: 'var(--sala-primary)',
              color: 'var(--sala-text-on-primary)',
              fontSize: '14px',
              fontWeight: 600,
              textDecoration: 'none',
              alignItems: 'center'
            }}
          >
            Ver clases disponibles →
          </Link>
        </div>
      </div>
    );
  }

  const estado = estadoCupos(clase);
  const llena = estado === 'llena';
  const pocos = estado === 'pocos';
  const esCancelada = clase.status === 'cancelada';

  return (
    <div style={{ minHeight: '100vh', paddingBottom: '180px' }}>
      <BackButton onClick={handleBack} />

      {/* Hero image */}
      <HeroImage
        url={recurso.foto_url}
        nombre={clase.nombre}
        disciplina={clase.disciplina}
      />

      <div
        style={{
          maxWidth: '720px',
          margin: '0 auto',
          padding: '24px 20px 0'
        }}
      >
        {/* Banner: clase cancelada */}
        {esCancelada && (
          <div
            style={{
              background: 'var(--sala-error-bg)',
              border: '1px solid rgba(196, 74, 53, 0.30)',
              borderRadius: '14px',
              padding: '14px 16px',
              marginBottom: '20px'
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
              Clase cancelada
            </p>
            <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
              Esta clase fue cancelada por el administrador.
              {yaReservada && ' Tu reserva queda registrada pero la clase no se realizará.'}
            </p>
          </div>
        )}

        {/* Header: eyebrow + título + meta */}
        <div style={{ marginBottom: '20px' }}>
          <p
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--sala-primary)',
              margin: 0,
              marginBottom: '10px'
            }}
          >
            {clase.disciplina}
          </p>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: 'clamp(28px, 7vw, 36px)',
              fontWeight: 600,
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              margin: 0,
              marginBottom: '10px',
              color: 'var(--sala-text-primary)'
            }}
          >
            {clase.nombre}
          </h1>
          <p
            style={{
              fontSize: '14px',
              color: 'var(--sala-text-secondary)',
              margin: 0,
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {formatHoraHumana(clase.slotInicio)} · {clase.duracionMinutos} min
          </p>
        </div>

        {/* Instructor */}
        <div
          style={{
            display: 'flex',
            alignItems: clase.instructorBio ? 'flex-start' : 'center',
            gap: '12px',
            marginBottom: '28px',
            padding: '14px 16px',
            background: 'var(--sala-surface)',
            border: '1px solid var(--sala-border)',
            borderRadius: '14px'
          }}
        >
          <InstructorAvatar nombre={clase.instructorNombre} fotoUrl={clase.instructorFotoUrl} />
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--sala-text-tertiary)',
                margin: 0,
                marginBottom: '2px'
              }}
            >
              Instructor
            </p>
            <p
              style={{
                fontSize: '15px',
                fontWeight: 600,
                color: clase.instructorNombre
                  ? 'var(--sala-text-primary)'
                  : 'var(--sala-text-tertiary)',
                margin: 0
              }}
            >
              {clase.instructorNombre ?? 'Por confirmar'}
            </p>
            {clase.instructorBio && (
              <p
                style={{
                  fontSize: '13px',
                  color: 'var(--sala-text-secondary)',
                  margin: '4px 0 0',
                  lineHeight: 1.5
                }}
              >
                {clase.instructorBio}
              </p>
            )}
          </div>
        </div>

        {/* Disponibilidad */}
        <section style={{ marginBottom: '28px' }}>
          <SectionHeading>Disponibilidad</SectionHeading>
          <div
            style={{
              background: 'var(--sala-surface)',
              border: '1px solid var(--sala-border)',
              borderRadius: '14px',
              padding: '18px'
            }}
          >
            <CupoBar clase={clase} size="lg" showLabel={false} />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginTop: '12px',
                gap: '12px'
              }}
            >
              <p
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: llena
                    ? 'var(--sala-text-tertiary)'
                    : pocos
                      ? 'var(--sala-accent)'
                      : 'var(--sala-text-primary)',
                  margin: 0,
                  fontVariantNumeric: 'tabular-nums',
                  fontFamily: 'var(--ek-font-display)',
                  letterSpacing: '-0.02em'
                }}
              >
                {llena
                  ? 'Clase llena'
                  : pocos
                    ? `¡Quedan ${clase.cupoMax - clase.cuposReservados} lugares!`
                    : `${clase.cuposReservados}/${clase.cupoMax} reservados`}
              </p>
              {!llena && !pocos && (
                <p
                  style={{
                    fontSize: '13px',
                    color: 'var(--sala-text-secondary)',
                    margin: 0,
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {clase.cupoMax - clase.cuposReservados} cupos libres
                </p>
              )}
            </div>
          </div>
        </section>

        {/* Descripción (oculta si no hay) */}
        {clase.descripcion && (
          <section style={{ marginBottom: '28px' }}>
            <SectionHeading>Sobre la clase</SectionHeading>
            <p
              style={{
                fontSize: '15px',
                color: 'var(--sala-text-primary)',
                margin: 0,
                lineHeight: 1.6
              }}
            >
              {clase.descripcion}
            </p>
          </section>
        )}

        {/* Gate por tier (informativo, abajo del CTA va el botón disabled) */}
        {!puedeAccederTier && (
          <div
            style={{
              padding: '14px 16px',
              background: 'var(--sala-warning-bg)',
              border: '1px solid rgba(200, 148, 31, 0.3)',
              borderRadius: '14px',
              marginBottom: '20px'
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
              Plan no incluido
            </p>
            <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
              Tu plan actual no incluye acceso a esta sala.{' '}
              <Link
                to="/app/perfil"
                style={{ color: 'var(--sala-primary)', fontWeight: 600 }}
              >
                Ver mi membresía →
              </Link>
            </p>
          </div>
        )}
      </div>

      {/* Sticky CTA */}
      <StickyCTA>
        <StickyAction
          cancelada={esCancelada}
          yaReservada={yaReservada}
          puedeAccederTier={puedeAccederTier}
          esFutura={esFutura}
          llena={llena}
          pocos={pocos}
          onReservar={handleReservar}
          onCancelar={() => setShowCancelModal(true)}
          onVolver={handleBack}
        />
      </StickyCTA>

      {/* Modals */}
      {showReservaModal && clase && (
        <ConfirmarReservaModal
          clase={clase}
          maxInvitados={maxInvitados}
          invitados={invitados}
          onInvitadosChange={setInvitados}
          submitting={submitting}
          error={errorReserva}
          onConfirm={confirmarReserva}
          onClose={() => !submitting && setShowReservaModal(false)}
        />
      )}

      {showCancelModal && clase && (
        <ConfirmarCancelacionModal
          clase={clase}
          submitting={submitting}
          onConfirm={confirmarCancelacion}
          onClose={() => !submitting && setShowCancelModal(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Sub-componentes locales
// ============================================================================

function BackButton({ onClick, inline = false }: { onClick: () => void; inline?: boolean }) {
  const baseStyle: React.CSSProperties = {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    background: 'rgba(250, 250, 247, 0.92)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: '1px solid var(--sala-border)',
    color: 'var(--sala-text-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: '18px',
    fontFamily: 'inherit',
    boxShadow: '0 2px 8px rgba(26, 31, 28, 0.08)'
  };

  if (inline) {
    return (
      <button type="button" onClick={onClick} aria-label="Volver" style={baseStyle}>
        ←
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Volver"
      style={{
        ...baseStyle,
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
        left: '16px',
        zIndex: 30
      }}
    >
      ←
    </button>
  );
}

function HeroImage({
  url,
  nombre,
  disciplina
}: {
  url: string | null;
  nombre: string;
  disciplina: string;
}) {
  if (url) {
    return (
      <div
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          background: 'var(--sala-bg)',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        <img
          src={url}
          alt={nombre}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block'
          }}
        />
      </div>
    );
  }

  // Placeholder con gradient y emoji
  return (
    <div
      style={{
        width: '100%',
        aspectRatio: '16 / 9',
        background:
          'linear-gradient(135deg, var(--sala-primary-light) 0%, var(--sala-bg) 60%, var(--sala-accent-light) 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative'
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontSize: 'clamp(64px, 16vw, 96px)',
          opacity: 0.65,
          filter: 'saturate(0.7)'
        }}
      >
        {emojiFor(disciplina)}
      </span>
    </div>
  );
}

function InstructorAvatar({ nombre, fotoUrl }: { nombre?: string; fotoUrl?: string }) {
  const inicial = (nombre?.trim().charAt(0) ?? '·').toUpperCase();
  if (fotoUrl) {
    return (
      <img
        src={fotoUrl}
        alt={nombre ?? 'Instructor'}
        style={{
          flexShrink: 0,
          width: '44px',
          height: '44px',
          borderRadius: '50%',
          objectFit: 'cover',
          border: '1px solid var(--sala-border)'
        }}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      style={{
        flexShrink: 0,
        width: '44px',
        height: '44px',
        borderRadius: '50%',
        background: nombre ? 'var(--sala-primary)' : 'var(--sala-bg)',
        color: nombre ? 'var(--sala-text-on-primary)' : 'var(--sala-text-tertiary)',
        border: nombre ? 'none' : '1px solid var(--sala-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--ek-font-display)',
        fontSize: '18px',
        fontWeight: 700,
        letterSpacing: '-0.02em'
      }}
    >
      {inicial}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontFamily: 'var(--ek-font-display)',
        fontSize: '14px',
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--sala-text-secondary)',
        margin: 0,
        marginBottom: '12px'
      }}
    >
      {children}
    </h2>
  );
}

function StickyCTA({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed',
        // Above the BottomNav (88px) + safe-area
        bottom: 'calc(88px + env(safe-area-inset-bottom, 0px))',
        left: 0,
        right: 0,
        zIndex: 25,
        padding: '12px 20px',
        background: 'rgba(250, 250, 247, 0.92)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--sala-border)'
      }}
    >
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>
        {children}
      </div>
    </div>
  );
}

function StickyAction({
  cancelada,
  yaReservada,
  puedeAccederTier,
  esFutura,
  llena,
  pocos,
  onReservar,
  onCancelar,
  onVolver
}: {
  cancelada: boolean;
  yaReservada: boolean;
  puedeAccederTier: boolean;
  esFutura: boolean;
  llena: boolean;
  pocos: boolean;
  onReservar: () => void;
  onCancelar: () => void;
  onVolver: () => void;
}) {
  const baseFullCTA: React.CSSProperties = {
    width: '100%',
    minHeight: '52px',
    padding: '14px 24px',
    fontSize: '15px',
    fontWeight: 700,
    borderRadius: '14px',
    border: '1px solid transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.18s ease, border-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease'
  };

  if (cancelada) {
    return (
      <button
        type="button"
        onClick={onVolver}
        style={{
          ...baseFullCTA,
          background: 'var(--sala-primary)',
          color: 'var(--sala-text-on-primary)',
          borderColor: 'var(--sala-primary)'
        }}
      >
        Volver
      </button>
    );
  }

  if (yaReservada) {
    return (
      <button
        type="button"
        onClick={onCancelar}
        style={{
          ...baseFullCTA,
          background: 'transparent',
          color: 'var(--sala-accent)',
          borderColor: 'var(--sala-accent)'
        }}
      >
        Cancelar reserva
      </button>
    );
  }

  if (!esFutura) {
    return (
      <button
        type="button"
        disabled
        style={{
          ...baseFullCTA,
          background: 'var(--sala-bg)',
          color: 'var(--sala-text-tertiary)',
          borderColor: 'var(--sala-border)',
          cursor: 'not-allowed'
        }}
      >
        Esta clase ya pasó
      </button>
    );
  }

  if (llena) {
    return (
      <button
        type="button"
        onClick={onReservar}
        style={{
          ...baseFullCTA,
          background: 'transparent',
          color: 'var(--sala-accent)',
          borderColor: 'var(--sala-accent)'
        }}
      >
        Anotarme en lista de espera
      </button>
    );
  }

  if (!puedeAccederTier) {
    return (
      <Link
        to="/app/perfil"
        style={{
          ...baseFullCTA,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--sala-warning)',
          color: 'var(--sala-text-on-primary)',
          borderColor: 'var(--sala-warning)',
          textDecoration: 'none'
        }}
      >
        Mejorar plan
      </Link>
    );
  }

  if (pocos) {
    return (
      <button
        type="button"
        onClick={onReservar}
        style={{
          ...baseFullCTA,
          background: 'var(--sala-accent)',
          color: 'var(--sala-text-on-accent)',
          borderColor: 'var(--sala-accent)',
          boxShadow: '0 4px 16px rgba(232, 101, 74, 0.24)'
        }}
      >
        Reservar (últimos lugares)
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onReservar}
      style={{
        ...baseFullCTA,
        background: 'var(--sala-primary)',
        color: 'var(--sala-text-on-primary)',
        borderColor: 'var(--sala-primary)',
        boxShadow: '0 4px 16px rgba(61, 107, 82, 0.24)'
      }}
    >
      Reservar
    </button>
  );
}
