import { useEffect, useMemo, useState } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { supabase } from '@shared/lib/supabase';
import {
  useRecursosDelTenant,
  crearReserva,
  cancelarReserva as cancelarReservaRPC
} from '@member/hooks/useReservas';
import {
  generarFechasReservables,
  type TenantReservaConfig
} from '@member/logic/reservaLogic';
import {
  clasesDelDia,
  type Clase,
  type RecursoMin
} from '@member/logic/claseAdapter';
import { DayTabSelector } from '@member/components/DayTabSelector';
import { ClaseRow } from '@member/components/ClaseRow';
import { ConfirmarReservaModal } from '@member/components/ConfirmarReservaModal';
import { ConfirmarCancelacionModal } from '@member/components/ConfirmarCancelacionModal';

const SALA_TODAS = '__todas__';

function tierTieneAcceso(tiers: string[] | null | undefined, tier: string | null | undefined): boolean {
  if (!tier) return false;
  if (!tiers || tiers.length === 0) return true; // recurso sin restricción
  return tiers.includes(tier);
}

export default function Reservar() {
  const tenant = useTenant();
  const { usuario } = useAuth();
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

  // 7 días desde hoy
  const fechas = useMemo(() => generarFechasReservables(config).slice(0, 7), [config]);
  const [fechaSel, setFechaSel] = useState<string>(fechas[0]?.fechaISO ?? '');
  const [salaSel, setSalaSel] = useState<string>(SALA_TODAS);

  // Datos del día seleccionado
  const [reservasDelDia, setReservasDelDia] = useState<Array<{ recurso_id: string; slot_inicio: string }>>([]);
  const [misReservasIds, setMisReservasIds] = useState<Map<string, string>>(new Map()); // clave → reserva.id
  const [loadingDia, setLoadingDia] = useState(false);

  // Modal de reserva
  const [claseAReservar, setClaseAReservar] = useState<Clase | null>(null);
  const [invitados, setInvitados] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [errorReserva, setErrorReserva] = useState<string | null>(null);

  // Cancelación (confirmación + flag)
  const [claseACancelar, setClaseACancelar] = useState<Clase | null>(null);
  const [cancelando, setCancelando] = useState(false);

  // Trigger refresh
  const [refreshTick, setRefreshTick] = useState(0);
  const triggerRefresh = () => setRefreshTick((t) => t + 1);

  // Cargar reservas del día seleccionado
  useEffect(() => {
    if (!fechaSel || !usuario) return;
    let mounted = true;
    setLoadingDia(true);

    async function load() {
      const inicio = new Date(fechaSel + 'T00:00:00');
      const fin = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);

      const [allRes, misRes] = await Promise.all([
        supabase
          .from('reservas')
          .select('recurso_id, slot_inicio')
          .eq('tenant_id', tenant.id)
          .in('status', ['confirmada', 'completada'])
          .gte('slot_inicio', inicio.toISOString())
          .lt('slot_inicio', fin.toISOString()),
        supabase
          .from('reservas')
          .select('id, recurso_id, slot_inicio')
          .eq('usuario_id', usuario!.id)
          .in('status', ['confirmada', 'completada'])
          .gte('slot_inicio', inicio.toISOString())
          .lt('slot_inicio', fin.toISOString())
      ]);

      if (!mounted) return;
      setReservasDelDia((allRes.data ?? []) as Array<{ recurso_id: string; slot_inicio: string }>);
      const map = new Map<string, string>();
      ((misRes.data ?? []) as Array<{ id: string; recurso_id: string; slot_inicio: string }>).forEach((r) => {
        const key = `${r.recurso_id}_${new Date(r.slot_inicio).getTime()}`;
        map.set(key, r.id);
      });
      setMisReservasIds(map);
      setLoadingDia(false);
    }
    void load();
    return () => { mounted = false; };
  }, [fechaSel, tenant.id, usuario, refreshTick]);

  // Computar las Clases del día
  const clases = useMemo<Clase[]>(() => {
    if (!fechaSel || recursos.length === 0) return [];
    const recursosFiltrados =
      salaSel === SALA_TODAS ? recursos : recursos.filter((r) => r.id === salaSel);
    const todas = clasesDelDia(
      recursosFiltrados as unknown as RecursoMin[],
      fechaSel,
      config.duracion_default_min,
      reservasDelDia
    );
    // Si la fecha es HOY, filtrar pasadas
    const hoy = new Date();
    const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    const esHoy = fechaSel === inicioHoy.toISOString().slice(0, 10);
    if (!esHoy) return todas;
    const ahora = Date.now();
    return todas.filter((c) => c.slotInicio.getTime() >= ahora);
  }, [fechaSel, recursos, salaSel, config.duracion_default_min, reservasDelDia]);

  const maxInvitados = tier === 'pro' ? 4 : tier === 'basica' ? 2 : 0;

  // === Handlers ===

  function handleReservar(clase: Clase) {
    const estadoLlena = clase.cuposReservados >= clase.cupoMax;
    if (estadoLlena) {
      toast.info('Lista de espera próximamente. Probá con otro horario por ahora.');
      return;
    }
    setErrorReserva(null);
    setInvitados(0);
    setClaseAReservar(clase);
  }

  function handleCancelar(clase: Clase) {
    setClaseACancelar(clase);
  }

  async function confirmarReserva() {
    if (!claseAReservar) return;
    setSubmitting(true);
    setErrorReserva(null);
    try {
      await crearReserva({
        recursoId: claseAReservar.recursoId,
        slotInicio: claseAReservar.slotInicio,
        duracionMin: claseAReservar.duracionMinutos,
        invitados,
        notas: undefined
      });
      setClaseAReservar(null);
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
    if (!claseACancelar) return;
    const claveBusqueda = `${claseACancelar.recursoId}_${claseACancelar.slotInicio.getTime()}`;
    const reservaId = misReservasIds.get(claveBusqueda);
    if (!reservaId) {
      toast.error('No encontramos tu reserva. Recargá la página.');
      setClaseACancelar(null);
      return;
    }
    setCancelando(true);
    const { error } = await cancelarReservaRPC({ reserva_id: reservaId });
    setCancelando(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success('Reserva cancelada.');
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
          No hay salas activas en este momento. Contactá al administrador.
        </p>
      </div>
    );
  }

  return (
    <div className="ek-container" style={{ paddingTop: '12px', paddingBottom: '40px' }}>
      <header style={{ marginBottom: '20px' }}>
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
        ) : clases.length === 0 ? (
          <EmptyDia />
        ) : (
          clases.map((clase) => {
            const key = `${clase.recursoId}_${clase.slotInicio.getTime()}`;
            const yaReservada = misReservasIds.has(key);
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
          onInvitadosChange={setInvitados}
          submitting={submitting}
          error={errorReserva}
          onConfirm={confirmarReserva}
          onClose={() => !submitting && setClaseAReservar(null)}
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
      onClick={onClick}
      style={{
        flexShrink: 0,
        padding: '8px 16px',
        minHeight: '36px',
        background: active ? 'var(--sala-primary)' : 'var(--sala-surface)',
        color: active ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
        border: `1px solid ${active ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
        borderRadius: '999px',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        transition: 'background 0.18s ease, border-color 0.18s ease, color 0.18s ease'
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
        Probá con otro día de la semana.
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
