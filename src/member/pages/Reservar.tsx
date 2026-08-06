import { useEffect, useMemo, useState } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { guardarInvitados, ajustarInvitados, type InvitadoDetalle } from '@shared/lib/invitados';
import { useMemberSucursal } from '@member/providers/MemberSucursalProvider';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { supabase } from '@shared/lib/supabase';
import {
  useRecursosDelTenant,
  crearReserva,
  cancelarReserva as cancelarReservaRPC,
  MultaRequeridaError
} from '@member/hooks/useReservas';
import { ConfirmarMultaModal } from '@member/components/ConfirmarMultaModal';
import { formatearMoneda } from '@shared/lib/dinero';
import {
  generarFechasReservables,
  mensajeToastCancelacion,
  traducirErrorRPC,
  type TenantReservaConfig
} from '@member/logic/reservaLogic';
import {
  claseFromExpansion,
  type Clase,
  type ClaseExpansionRow
} from '@member/logic/claseAdapter';
import { getTenantTimezone } from '@shared/lib/timezone';
import { useMaxInvitados } from '@member/hooks/useMaxInvitados';
import { DayTabSelector } from '@member/components/DayTabSelector';
import { ClaseRow } from '@member/components/ClaseRow';
import { ConfirmarReservaModal } from '@member/components/ConfirmarReservaModal';
import { useMembresiaActual } from '@member/hooks/useMembresiaActual';
import { ConfirmarCancelacionModal } from '@member/components/ConfirmarCancelacionModal';
import { ConfirmarListaEsperaModal } from '@member/components/ConfirmarListaEsperaModal';
import { anotarseEnListaEspera } from '@member/hooks/useListaEspera';

const SALA_TODAS = '__todas__';

function tierTieneAcceso(tiers: string[] | null | undefined, tier: string | null | undefined): boolean {
  if (!tier) return false;
  if (!tiers || tiers.length === 0) return true; // recurso sin restricción
  return tiers.includes(tier);
}

export default function Reservar() {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const { sucursalId } = useMemberSucursal();
  const toast = useToast();
  const { recursos, isLoading: loadingRecursos } = useRecursosDelTenant();

  const config = useMemo<TenantReservaConfig>(() => {
    const c = (tenant.config as Record<string, any> | null | undefined)?.reserva ?? {};
    return {
      duracion_default_min: c.duracion_default_min ?? 60,
      cupos_por_recurso: c.cupos_por_recurso ?? 1,
      permitir_continuas: c.permitir_continuas ?? false,
      anticipacion_min_horas: c.anticipacion_min_horas ?? 24,
      anticipacion_max_dias: c.anticipacion_max_dias ?? 30,
      ventana_check_in_min: c.ventana_check_in_min ?? 15
    };
  }, [tenant.config]);

  const tier = usuario?.membresia_tier ?? null;
  const tz = getTenantTimezone(tenant);

  // 7 días desde hoy (en la timezone del gym)
  const fechas = useMemo(
    () => generarFechasReservables(config, tz).slice(0, 7),
    [config, tz]
  );
  const [fechaSel, setFechaSel] = useState<string>(fechas[0]?.fechaISO ?? '');
  const [salaSel, setSalaSel] = useState<string>(SALA_TODAS);

  // Modelo virtual: las clases del día las calcula expandir_clases (virtuales +
  // materializadas), ya como Clase[]. misReservasIds: clase_id → reserva.id del
  // usuario (solo materializadas; una virtual no puede estar reservada).
  const [clasesDelDia, setClasesDelDia] = useState<Clase[]>([]);
  const [misReservasIds, setMisReservasIds] = useState<Map<string, string>>(new Map());
  const [loadingDia, setLoadingDia] = useState(false);
  const [errorDia, setErrorDia] = useState(false);

  // Modal de reserva
  const [claseAReservar, setClaseAReservar] = useState<Clase | null>(null);
  const [invitados, setInvitados] = useState(0);
  const [invitadosDetalle, setInvitadosDetalle] = useState<InvitadoDetalle[]>([]);
  const [lugarId, setLugarId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorReserva, setErrorReserva] = useState<string | null>(null);
  const [multaPendiente, setMultaPendiente] = useState<number | null>(null);

  // Cancelación (confirmación + flag)
  const [claseACancelar, setClaseACancelar] = useState<Clase | null>(null);
  const [claseAEspera, setClaseAEspera] = useState<Clase | null>(null);
  const [submittingEspera, setSubmittingEspera] = useState(false);
  const [cancelando, setCancelando] = useState(false);

  // Trigger refresh
  const [refreshTick, setRefreshTick] = useState(0);
  const triggerRefresh = () => setRefreshTick((t) => t + 1);

  // Modelo virtual: expandir_clases calcula las clases del día (virtuales de las
  // reglas + materializadas con sus overrides/reservados). Una sola RPC; los
  // cupos vienen en `reservados`. Solo falta saber cuáles ya reservó el usuario.
  useEffect(() => {
    if (!fechaSel || !usuario) return;
    let mounted = true;
    setLoadingDia(true);

    async function load() {
      // expandir_clases no está en los tipos generados → cast.
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ data: ClaseExpansionRow[] | null; error: { message: string } | null }>;

      const { data, error } = await rpc('expandir_clases', {
        p_sucursal_id: sucursalId, // sede activa del socio (null = todas)
        p_desde: fechaSel,
        p_hasta: fechaSel
      });
      if (!mounted) return;
      if (error) {
        // Sin esto el día se veía vacío igual que "no hay clases", y el socio no
        // sabía si no había nada o si falló la carga.
        console.error('[Reservar:expandir_clases]', error, { fechaSel });
        setClasesDelDia([]);
        setMisReservasIds(new Map());
        setErrorDia(true);
        setLoadingDia(false);
        return;
      }
      setErrorDia(false);

      const rows = (data ?? []) as ClaseExpansionRow[];
      const mapped = rows
        .map((r) => claseFromExpansion(r, tz))
        .sort((a, b) => a.slotInicio.getTime() - b.slotInicio.getTime());

      // Mis reservas: solo las materializadas (una virtual no puede estar reservada).
      const claseIds = rows.map((r) => r.clase_id).filter((x): x is string => !!x);
      const misMap = new Map<string, string>();
      if (claseIds.length > 0) {
        const { data: misRes } = await supabase
          .from('reservas')
          .select('id, clase_id')
          .eq('usuario_id', usuario!.id)
          .in('clase_id', claseIds)
          .in('status', ['confirmada', 'completada']);
        for (const r of (misRes ?? []) as Array<{ id: string; clase_id: string | null }>) {
          if (r.clase_id) misMap.set(r.clase_id, r.id);
        }
      }

      if (!mounted) return;
      setClasesDelDia(mapped);
      setMisReservasIds(misMap);
      setLoadingDia(false);
    }
    void load();
    return () => { mounted = false; };
  }, [fechaSel, tenant.id, usuario, tz, refreshTick, sucursalId]);

  // Filtro de sala + "ya pasó" si es hoy. (El mapeo ya se hizo en la carga.)
  const clases = useMemo<Clase[]>(() => {
    const filtradas =
      salaSel === SALA_TODAS ? clasesDelDia : clasesDelDia.filter((c) => c.recursoId === salaSel);
    // esHoy: fechas[0].fechaISO ya es "hoy" en la tz del gym.
    const esHoy = fechaSel === fechas[0]?.fechaISO;
    if (!esHoy) return filtradas;
    const ahora = Date.now();
    return filtradas.filter((c) => c.slotInicio.getTime() >= ahora);
  }, [clasesDelDia, salaSel, fechaSel, fechas]);

  const maxInvitados = useMaxInvitados();
  // Plan por créditos → la reserva cuesta 1 + invitados (cada lugar = 1 crédito).
  const { membresia } = useMembresiaActual(usuario?.id);
  const esPlanCreditos =
    membresia?.tier_tipo === 'creditos' || membresia?.tier_tipo === 'hibrido';

  // === Handlers ===

  function handleReservar(clase: Clase) {
    const estadoLlena = clase.cuposReservados >= clase.cupoMax;
    if (estadoLlena) {
      // Clase llena → lista de espera (la feature existe; antes dia "próximamente").
      setClaseAEspera(clase);
      return;
    }
    setErrorReserva(null);
    setInvitados(0);
    setInvitadosDetalle([]);
    setLugarId(null);
    setClaseAReservar(clase);
  }

  async function confirmarEspera() {
    if (!claseAEspera) return;
    setSubmittingEspera(true);
    try {
      const { posicion } = await anotarseEnListaEspera({
        claseId: claseAEspera.claseId,
        horarioId: claseAEspera.horarioId,
        fecha: claseAEspera.fechaISO
      });
      setClaseAEspera(null);
      setSubmittingEspera(false);
      toast.success(`Estás en lista de espera, posición #${posicion}.`);
      triggerRefresh();
    } catch (e) {
      setSubmittingEspera(false);
      toast.error(e instanceof Error ? traducirErrorRPC(e.message) : 'No pudimos anotarte en la lista.');
    }
  }

  function handleCancelar(clase: Clase) {
    setClaseACancelar(clase);
  }

  async function confirmarReserva(aceptaMulta = false) {
    if (!claseAReservar) return;
    setSubmitting(true);
    setErrorReserva(null);
    try {
      const res = await crearReserva({
        claseId: claseAReservar.claseId,
        horarioId: claseAReservar.horarioId,
        fecha: claseAReservar.fechaISO,
        invitados,
        notas: undefined,
        lugarId,
        aceptaMulta
      });
      // Guardar la identidad de los invitados (best-effort: la reserva ya existe).
      const reservaId = (res as { reserva_id?: string } | null)?.reserva_id;
      if (reservaId && invitados > 0) {
        try {
          await guardarInvitados({ reservaId, tenantId: tenant.id, invitados: invitadosDetalle });
        } catch {
          toast.error('Reserva confirmada, pero no pudimos guardar los datos del invitado. Recepción los puede completar.');
        }
      }
      const multa = (res as { multa_centavos?: number } | null)?.multa_centavos ?? 0;
      setClaseAReservar(null);
      setMultaPendiente(null);
      setSubmitting(false);
      toast.success(
        multa > 0
          ? `Reserva confirmada. Multa de ${formatearMoneda(multa)} — se cobra en recepción.`
          : 'Reserva confirmada.'
      );
      triggerRefresh();
    } catch (e) {
      // El tope diario pide confirmar la multa (Modelo A): abrir el modal en vez de error.
      if (e instanceof MultaRequeridaError) {
        setMultaPendiente(e.centavos);
        setSubmitting(false);
        return;
      }
      const msg = e instanceof Error ? traducirErrorRPC(e.message) : 'Error reservando';
      setErrorReserva(msg);
      setSubmitting(false);
    }
  }

  async function confirmarCancelacion() {
    if (!claseACancelar) return;
    const reservaId = claseACancelar.claseId ? misReservasIds.get(claseACancelar.claseId) : undefined;
    if (!reservaId) {
      toast.error('No encontramos tu reserva. Recarga la página.');
      setClaseACancelar(null);
      return;
    }
    setCancelando(true);
    const { data, error } = await cancelarReservaRPC({ reserva_id: reservaId });
    setCancelando(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(mensajeToastCancelacion(data?.devolucion_motivo));
    setClaseACancelar(null);
    triggerRefresh();
  }

  if (loadingRecursos) {
    return (
      <div className="ek-container">
        <p style={{ color: 'var(--sala-text-secondary)' }}>Cargando salas…</p>
      </div>
    );
  }

  if (recursos.length === 0) {
    return (
      <div className="ek-container">
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--sala-text-tertiary)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Sin salas disponibles
        </p>
        <p style={{ color: 'var(--sala-text-secondary)' }}>
          No hay salas activas en este momento. Contacta al administrador.
        </p>
      </div>
    );
  }

  return (
    <div className="ek-container" style={{ paddingTop: '12px', paddingBottom: '40px' }}>
      <header style={{ marginBottom: '20px' }}>
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--sala-accent)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Elige tu clase
        </p>
        <h1
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(28px, 7vw, 36px)',
            fontWeight: 600,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            margin: 0,
            color: 'var(--sala-text-primary)'
          }}
        >
          Reservar
        </h1>
      </header>

      {/* Filtro de sala (chips horizontales scrolleables) */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          overflowX: 'auto',
          paddingBottom: '8px',
          marginInline: '-20px',
          paddingInline: '20px',
          marginBottom: '20px',
          scrollbarWidth: 'none'
        }}
      >
        <SalaChip
          label="Todas las salas"
          active={salaSel === SALA_TODAS}
          onClick={() => setSalaSel(SALA_TODAS)}
        />
        {recursos.map((r) => (
          <SalaChip
            key={r.id}
            label={r.nombre}
            active={salaSel === r.id}
            onClick={() => setSalaSel(r.id)}
          />
        ))}
      </div>

      {/* Tabs de 7 días */}
      <div style={{ marginBottom: '24px' }}>
        <DayTabSelector
          fechas={fechas}
          selectedFechaISO={fechaSel}
          onSelect={setFechaSel}
        />
      </div>

      {/* Lista de clases */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {loadingDia ? (
          <SkeletonRows />
        ) : errorDia ? (
          <ErrorDia />
        ) : clases.length === 0 ? (
          <EmptyDia />
        ) : (
          clases.map((clase) => {
            const yaReservada = !!clase.claseId && misReservasIds.has(clase.claseId);
            const puede = tierTieneAcceso(clase.tiersPermitidos, tier);
            return (
              <ClaseRow
                key={clase.id}
                clase={clase}
                yaReservada={yaReservada}
                puedeReservar={puede}
                reservando={submitting && claseAReservar?.id === clase.id}
                onReservar={() => handleReservar(clase)}
                onCancelar={() => handleCancelar(clase)}
              />
            );
          })
        )}
      </div>

      {/* Modal: confirmar reserva */}
      {claseAReservar && (
        <ConfirmarReservaModal
          clase={claseAReservar}
          maxInvitados={maxInvitados}
          invitados={invitados}
          onInvitadosChange={(n) => { setInvitados(n); setInvitadosDetalle((prev) => ajustarInvitados(prev, n)); }}
          invitadosDetalle={invitadosDetalle}
          onInvitadosDetalleChange={setInvitadosDetalle}
          costoCreditos={esPlanCreditos ? 1 + invitados : null}
          creditosRestantes={esPlanCreditos ? membresia?.creditos_restantes ?? null : null}
          lugarId={lugarId}
          onLugarChange={setLugarId}
          submitting={submitting}
          error={errorReserva}
          onConfirm={() => confirmarReserva()}
          onClose={() => !submitting && setClaseAReservar(null)}
        />
      )}

      {multaPendiente !== null && (
        <ConfirmarMultaModal
          centavos={multaPendiente}
          submitting={submitting}
          onConfirm={() => confirmarReserva(true)}
          onClose={() => !submitting && setMultaPendiente(null)}
        />
      )}

      {/* Modal: confirmar cancelación */}
      {claseACancelar && (
        <ConfirmarCancelacionModal
          clase={claseACancelar}
          submitting={cancelando}
          onConfirm={confirmarCancelacion}
          onClose={() => !cancelando && setClaseACancelar(null)}
        />
      )}

      {/* Modal: anotarse en lista de espera (clase llena) */}
      {claseAEspera && (
        <ConfirmarListaEsperaModal
          clase={claseAEspera}
          totalEnEspera={0}
          submitting={submittingEspera}
          onConfirm={confirmarEspera}
          onClose={() => !submittingEspera && setClaseAEspera(null)}
        />
      )}

    </div>
  );
}

// ============================================================================
// Sub-componentes locales
// ============================================================================

function SalaChip({
  label,
  active,
  onClick
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="ek-lift"
      onClick={onClick}
      style={{
        flexShrink: 0,
        padding: '8px 16px',
        minHeight: '44px',
        background: active ? 'var(--grad-accent)' : 'var(--sala-surface)',
        color: active ? 'var(--sala-text-on-accent)' : 'var(--sala-text-secondary)',
        border: `1px solid ${active ? 'var(--sala-accent)' : 'var(--sala-border)'}`,
        borderRadius: '999px',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        boxShadow: active
          ? '0 2px 10px var(--sala-accent-dim), inset 0 1px 0 rgba(255, 255, 255, 0.16)'
          : 'none',
        transition:
          'background 0.18s ease, border-color 0.18s ease, color 0.18s ease, transform 0.16s ease, filter 0.18s ease'
      }}
    >
      {label}
    </button>
  );
}

function EmptyDia() {
  return (
    <div
      style={{
        padding: '48px 20px',
        textAlign: 'center',
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '14px'
      }}
    >
      <p
        style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--sala-text-tertiary)',
          margin: 0,
          marginBottom: '8px'
        }}
      >
        Sin clases
      </p>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '18px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: 'var(--sala-text-primary)',
          margin: 0,
          marginBottom: '4px'
        }}
      >
        No hay clases programadas para este día.
      </p>
      <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0 }}>
        Prueba con otro día de la semana.
      </p>
    </div>
  );
}

function ErrorDia() {
  return (
    <div
      style={{
        padding: '48px 20px',
        textAlign: 'center',
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-error)',
        borderRadius: '14px'
      }}
    >
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '18px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: 'var(--sala-text-primary)',
          margin: 0,
          marginBottom: '4px'
        }}
      >
        No pudimos cargar las clases
      </p>
      <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0 }}>
        Revisá tu conexión y probá cambiando de día, o volvé a entrar en un momento.
      </p>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[1, 2, 3].map((n) => (
        <div
          key={n}
          className="ek-skeleton"
          style={{ height: '120px', borderRadius: '14px' }}
        />
      ))}
    </>
  );
}
