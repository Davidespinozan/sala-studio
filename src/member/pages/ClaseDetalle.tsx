import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bike,
  Dumbbell,
  Flower2,
  Footprints,
  Gauge,
  Heart,
  Music,
  Share2,
  Swords,
  type LucideIcon
} from 'lucide-react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { supabase } from '@shared/lib/supabase';
import { crearReserva, cancelarReserva as cancelarReservaRPC } from '@member/hooks/useReservas';
import { useMaxInvitados } from '@member/hooks/useMaxInvitados';
import { useFavoritos } from '@member/hooks/useFavoritos';
import { mensajeToastCancelacion, traducirErrorRPC } from '@member/logic/reservaLogic';
import {
  anotarseEnListaEspera,
  salirDeListaEspera,
  miPosicionEnLista,
  type MiPosicionEspera
} from '@member/hooks/useListaEspera';
import {
  claseFromExpansion,
  estadoCupos,
  type Clase,
  type ClaseExpansionRow
} from '@member/logic/claseAdapter';
import { getTenantTimezone } from '@shared/lib/timezone';
import { CupoBar } from '@member/components/CupoBar';
import { ConfirmarReservaModal } from '@member/components/ConfirmarReservaModal';
import { useMembresiaActual } from '@member/hooks/useMembresiaActual';
import { ConfirmarCancelacionModal } from '@member/components/ConfirmarCancelacionModal';
import { ConfirmarListaEsperaModal } from '@member/components/ConfirmarListaEsperaModal';

/** Icono decorativo según disciplina, para placeholder cuando no hay foto. */
function iconFor(disciplina: string): LucideIcon {
  const d = disciplina.toLowerCase();
  if (d.includes('yoga') || d.includes('pilates') || d.includes('flow') || d.includes('stretch')) return Flower2;
  if (d.includes('spinning') || d.includes('cycling') || d.includes('bici') || d.includes('indoor')) return Bike;
  if (d.includes('crossfit') || d.includes('hiit') || d.includes('funcional') || d.includes('fuerza')) return Dumbbell;
  if (d.includes('baile') || d.includes('dance') || d.includes('zumba')) return Music;
  if (d.includes('boxeo') || d.includes('box')) return Swords;
  if (d.includes('correr') || d.includes('running')) return Footprints;
  return Dumbbell;
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
  const tz = getTenantTimezone(tenant);
  const toast = useToast();
  const { isFavorito, toggle: toggleFavorito } = useFavoritos();

  // El id de la URL es el UUID de una clase materializada, o el ref sintético de
  // una virtual: "horario_recurrente_id|fecha".
  const claseRef = useMemo<
    | { kind: 'real'; claseId: string }
    | { kind: 'virtual'; horarioId: string; fecha: string }
    | null
  >(() => {
    if (!id) return null;
    let raw: string;
    try { raw = decodeURIComponent(id); } catch { return null; }
    if (raw.includes('|')) {
      const [horarioId, fecha] = raw.split('|');
      return horarioId && fecha ? { kind: 'virtual', horarioId, fecha } : null;
    }
    return { kind: 'real', claseId: raw };
  }, [id]);

  const [clase, setClase] = useState<Clase | null>(null);
  const [miReservaId, setMiReservaId] = useState<string | null>(null);
  const [miEspera, setMiEspera] = useState<MiPosicionEspera | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Modales
  const [showReservaModal, setShowReservaModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showEsperaModal, setShowEsperaModal] = useState(false);
  const [invitados, setInvitados] = useState(0);
  const [lugarId, setLugarId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorReserva, setErrorReserva] = useState<string | null>(null);

  // Refresh tick
  const [refreshTick, setRefreshTick] = useState(0);
  const triggerRefresh = () => setRefreshTick((t) => t + 1);

  // Modelo virtual: resolvemos la clase (virtual o materializada) vía
  // expandir_clases para su día, y traemos mi reserva / lista de espera solo si
  // está materializada (una virtual no puede estar reservada).
  useEffect(() => {
    if (!usuario) return;
    if (!claseRef) { setNotFound(true); setIsLoading(false); return; }
    let mounted = true;
    setIsLoading(true);
    setNotFound(false);

    async function load() {
      const ref = claseRef!;
      // 1) Fecha del día a expandir (la virtual la trae; la real la resolvemos).
      let fecha: string;
      if (ref.kind === 'virtual') {
        fecha = ref.fecha;
      } else {
        const r = await supabase
          .from('clases').select('fecha')
          .eq('id', ref.claseId).eq('tenant_id', tenant.id).maybeSingle();
        if (!mounted) return;
        if (r.error || !r.data) { setNotFound(true); setIsLoading(false); return; }
        fecha = (r.data as { fecha: string }).fecha;
      }

      // 2) Expandir ese día y encontrar la instancia.
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string, args: Record<string, unknown>
      ) => Promise<{ data: ClaseExpansionRow[] | null; error: { message: string } | null }>;
      const { data, error } = await rpc('expandir_clases', {
        p_sucursal_id: null, p_desde: fecha, p_hasta: fecha
      });
      if (!mounted) return;
      const rows = (data ?? []) as ClaseExpansionRow[];
      const found = error ? undefined : rows.find((row) =>
        ref.kind === 'virtual'
          ? row.horario_recurrente_id === ref.horarioId
          : row.clase_id === ref.claseId
      );
      if (!found) { setNotFound(true); setIsLoading(false); return; }
      const c = claseFromExpansion(found, tz);

      // 3) Mi reserva + mi lista de espera (solo si está materializada).
      let miRes: string | null = null;
      let espera: MiPosicionEspera | null = null;
      if (c.claseId) {
        const [miR, esp] = await Promise.all([
          supabase.from('reservas')
            .select('id, status')
            .eq('usuario_id', usuario!.id).eq('clase_id', c.claseId)
            .in('status', ['confirmada', 'completada']).maybeSingle(),
          miPosicionEnLista(c.claseId).catch(() => null)
        ]);
        if (!mounted) return;
        miRes = (miR.data as { id: string } | null)?.id ?? null;
        espera = esp;
      }

      if (!mounted) return;
      setClase(c);
      setMiReservaId(miRes);
      setMiEspera(espera);
      setIsLoading(false);
    }

    void load();
    return () => { mounted = false; };
  }, [claseRef, usuario, tenant.id, tz, refreshTick]);

  const tier = usuario?.membresia_tier ?? null;
  const puedeAccederTier = clase ? tierTieneAcceso(clase.tiersPermitidos, tier) : false;
  const yaReservada = !!miReservaId;
  const esFutura = clase ? clase.slotInicio.getTime() > Date.now() : false;
  const maxInvitados = useMaxInvitados();
  // Si el plan es por créditos, la reserva cuesta 1 + invitados (cada lugar = 1
  // crédito). Para planes por tiempo (ilimitado) no se muestra costo.
  const { membresia } = useMembresiaActual(usuario?.id);
  const esPlanCreditos =
    membresia?.tier_tipo === 'creditos' || membresia?.tier_tipo === 'hibrido';

  const enEspera = miEspera?.en_lista ?? false;
  const posicionEspera = miEspera?.posicion ?? null;
  const totalEnEspera = miEspera?.total ?? 0;
  const fuePromovido = yaReservada && (miEspera?.promovido ?? false);

  // === Handlers ===

  function handleBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate('/app/reservar');
  }

  async function handleCompartir() {
    if (!clase) return;
    const url = window.location.href;
    const texto = `${clase.nombre} · ${clase.horaHumanaLabel}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: clase.nombre, text: texto, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast.success('Link copiado');
      }
    } catch {
      // El usuario canceló el diálogo de compartir: no es un error.
    }
  }

  function handleReservar() {
    if (!clase) return;
    const llena = clase.cuposReservados >= clase.cupoMax;
    if (llena) {
      handleAnotarEspera();
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
    setLugarId(null);
    setShowReservaModal(true);
  }

  function handleAnotarEspera() {
    if (!clase) return;
    if (!esFutura) {
      toast.error('Esta clase ya pasó.');
      return;
    }
    setShowEsperaModal(true);
  }

  async function confirmarReserva() {
    if (!clase) return;
    setSubmitting(true);
    setErrorReserva(null);
    try {
      await crearReserva({
        claseId: clase.claseId,
        horarioId: clase.horarioId,
        fecha: clase.fechaISO,
        invitados,
        notas: undefined,
        lugarId
      });
      setShowReservaModal(false);
      setSubmitting(false);
      toast.success('Reserva confirmada.');
      triggerRefresh();
    } catch (e) {
      const msg = e instanceof Error ? traducirErrorRPC(e.message) : 'Error reservando';
      setErrorReserva(msg);
      setSubmitting(false);
    }
  }

  async function confirmarCancelacion() {
    if (!miReservaId) return;
    setSubmitting(true);
    const { data, error } = await cancelarReservaRPC({ reserva_id: miReservaId });
    setSubmitting(false);
    if (error) {
      toast.error(traducirErrorRPC(error));
      return;
    }
    toast.success(mensajeToastCancelacion(data?.devolucion_motivo));
    setShowCancelModal(false);
    triggerRefresh();
  }

  async function confirmarAnotarEspera() {
    if (!clase) return;
    setSubmitting(true);
    try {
      const { posicion } = await anotarseEnListaEspera({
        claseId: clase.claseId,
        horarioId: clase.horarioId,
        fecha: clase.fechaISO
      });
      setShowEsperaModal(false);
      setSubmitting(false);
      toast.success(`Estás en lista de espera, posición #${posicion}.`);
      triggerRefresh();
    } catch (e) {
      setSubmitting(false);
      toast.error(e instanceof Error ? traducirErrorRPC(e.message) : 'No pudimos anotarte en la lista.');
    }
  }

  async function handleSalirEspera() {
    if (!clase || !clase.claseId) return; // solo materializada puede tener espera
    setSubmitting(true);
    try {
      await salirDeListaEspera(clase.claseId);
      setSubmitting(false);
      toast.success('Saliste de la lista de espera.');
      triggerRefresh();
    } catch (e) {
      setSubmitting(false);
      toast.error(e instanceof Error ? traducirErrorRPC(e.message) : 'No pudimos sacarte de la lista.');
    }
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

  if (notFound || !clase) {
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
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}
          >
            Ver clases disponibles
            <ArrowRight size={16} strokeWidth={2.25} />
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
        url={clase.imagenUrl ?? null}
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
              border: '1px solid var(--sala-error-glow)',
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

        {/* Banner: fuiste promovido desde la lista de espera */}
        {!esCancelada && fuePromovido && (
          <div
            style={{
              background: 'var(--sala-success-bg)',
              border: '1px solid var(--sala-success)',
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
                color: 'var(--sala-success)',
                margin: 0,
                marginBottom: '6px'
              }}
            >
              ¡Buenas noticias!
            </p>
            <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
              Se liberó un lugar y tu reserva ya está confirmada.
            </p>
          </div>
        )}

        {/* Banner: estás en lista de espera */}
        {!esCancelada && enEspera && (
          <div
            style={{
              background: 'var(--sala-primary-light)',
              border: '1px solid var(--sala-border)',
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
                color: 'var(--sala-primary)',
                margin: 0,
                marginBottom: '6px'
              }}
            >
              Lista de espera
            </p>
            <p
              style={{
                fontSize: '14px',
                color: 'var(--sala-text-primary)',
                margin: 0,
                lineHeight: 1.5,
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              Estás en lista de espera — <strong>posición #{posicionEspera}</strong>
              {totalEnEspera > 1 ? ` de ${totalEnEspera}` : ''}. Si se libera un lugar,
              te confirmamos la reserva automáticamente.
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
            {clase.horaHumanaLabel} · {clase.duracionMinutos} min
          </p>

          {/* Chips (intensidad) + compartir */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              marginTop: '14px',
              flexWrap: 'wrap'
            }}
          >
            {clase.intensidad && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 12px',
                  borderRadius: '999px',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  background: 'var(--sala-primary-light)',
                  border: '1px solid var(--sala-border)',
                  color:
                    clase.intensidad === 'alta'
                      ? 'var(--sala-accent)'
                      : clase.intensidad === 'baja'
                        ? 'var(--sala-text-secondary)'
                        : 'var(--sala-primary)'
                }}
              >
                <Gauge size={14} strokeWidth={2.25} />
                Intensidad {clase.intensidad}
              </span>
            )}
            <button
              type="button"
              aria-label={
                isFavorito(clase.recursoId) ? 'Quitar de favoritas' : 'Agregar a favoritas'
              }
              onClick={() => void toggleFavorito(clase.recursoId)}
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '38px',
                height: '38px',
                borderRadius: '999px',
                cursor: 'pointer',
                background: 'transparent',
                border: '1px solid var(--sala-border)',
                color: isFavorito(clase.recursoId)
                  ? 'var(--sala-accent)'
                  : 'var(--sala-text-secondary)'
              }}
            >
              <Heart
                size={16}
                strokeWidth={2.25}
                fill={isFavorito(clase.recursoId) ? 'var(--sala-accent)' : 'none'}
              />
            </button>
            <button
              type="button"
              onClick={handleCompartir}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '8px 14px',
                borderRadius: '999px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                background: 'transparent',
                border: '1px solid var(--sala-border)',
                color: 'var(--sala-text-secondary)'
              }}
            >
              <Share2 size={15} strokeWidth={2.25} />
              Compartir
            </button>
          </div>
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
            {clase.instructorRol && (
              <p
                style={{
                  fontSize: '13px',
                  fontWeight: 500,
                  color: 'var(--sala-text-secondary)',
                  margin: '2px 0 0'
                }}
              >
                {clase.instructorRol}
              </p>
            )}
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
                    ? clase.cupoMax - clase.cuposReservados === 1
                      ? '¡Queda 1 lugar!'
                      : `¡Quedan ${clase.cupoMax - clase.cuposReservados} lugares!`
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
              border: '1px solid var(--sala-warning-glow)',
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
                style={{ color: 'var(--sala-primary)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                Ver mi membresía
                <ArrowRight size={14} strokeWidth={2.25} />
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
          enEspera={enEspera}
          puedeAccederTier={puedeAccederTier}
          esFutura={esFutura}
          llena={llena}
          pocos={pocos}
          submitting={submitting}
          onReservar={handleReservar}
          onCancelar={() => setShowCancelModal(true)}
          onAnotarEspera={handleAnotarEspera}
          onSalirEspera={handleSalirEspera}
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
          costoCreditos={esPlanCreditos ? 1 + invitados : null}
          creditosRestantes={esPlanCreditos ? membresia?.creditos_restantes ?? null : null}
          lugarId={lugarId}
          onLugarChange={setLugarId}
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

      {showEsperaModal && clase && (
        <ConfirmarListaEsperaModal
          clase={clase}
          totalEnEspera={totalEnEspera}
          submitting={submitting}
          onConfirm={confirmarAnotarEspera}
          onClose={() => !submitting && setShowEsperaModal(false)}
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
        <ArrowLeft size={20} strokeWidth={2.25} />
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
      <ArrowLeft size={20} strokeWidth={2.25} />
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

  // Placeholder con gradient e icono de disciplina
  const Icon = iconFor(disciplina);
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
      <Icon
        aria-hidden="true"
        size={84}
        strokeWidth={1.25}
        style={{ color: 'var(--sala-primary)', opacity: 0.55 }}
      />
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
  enEspera,
  puedeAccederTier,
  esFutura,
  llena,
  pocos,
  submitting,
  onReservar,
  onCancelar,
  onAnotarEspera,
  onSalirEspera,
  onVolver
}: {
  cancelada: boolean;
  yaReservada: boolean;
  enEspera: boolean;
  puedeAccederTier: boolean;
  esFutura: boolean;
  llena: boolean;
  pocos: boolean;
  submitting: boolean;
  onReservar: () => void;
  onCancelar: () => void;
  onAnotarEspera: () => void;
  onSalirEspera: () => void;
  onVolver: () => void;
}) {
  const baseFullCTA: React.CSSProperties = {
    width: '100%',
    minHeight: '52px',
    padding: '14px 24px',
    fontSize: '15px',
    fontWeight: 700,
    borderRadius: '999px',
    border: '1px solid transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition:
      'background 0.18s ease, border-color 0.18s ease, color 0.18s ease, box-shadow 0.22s ease, transform 0.16s ease, filter 0.18s ease'
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

  if (enEspera) {
    return (
      <button
        type="button"
        onClick={onSalirEspera}
        disabled={submitting}
        style={{
          ...baseFullCTA,
          background: 'transparent',
          color: 'var(--sala-accent)',
          borderColor: 'var(--sala-accent)',
          cursor: submitting ? 'not-allowed' : 'pointer',
          opacity: submitting ? 0.6 : 1
        }}
      >
        {submitting ? 'Saliendo…' : 'Salir de la lista de espera'}
      </button>
    );
  }

  if (llena) {
    return (
      <button
        type="button"
        onClick={onAnotarEspera}
        style={{
          ...baseFullCTA,
          background: 'var(--sala-primary)',
          color: 'var(--sala-text-on-primary)',
          borderColor: 'var(--sala-primary)'
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
        className="ek-lift"
        onClick={onReservar}
        style={{
          ...baseFullCTA,
          background: 'var(--grad-accent)',
          color: 'var(--sala-text-on-accent)',
          borderColor: 'var(--sala-accent)',
          boxShadow: '0 4px 16px var(--sala-accent-dim), inset 0 1px 0 rgba(255, 255, 255, 0.16)'
        }}
      >
        Reservar (últimos lugares)
      </button>
    );
  }

  return (
    <button
      type="button"
      className="ek-lift"
      onClick={onReservar}
      style={{
        ...baseFullCTA,
        background: 'var(--grad-primary)',
        color: 'var(--sala-text-on-primary)',
        borderColor: 'var(--sala-primary)',
        boxShadow: '0 4px 16px var(--sala-primary-dim), inset 0 1px 0 rgba(255, 255, 255, 0.16)'
      }}
    >
      Reservar
    </button>
  );
}
