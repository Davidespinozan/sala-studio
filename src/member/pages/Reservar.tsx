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
import { claseFromRow, type Clase } from '@member/logic/claseAdapter';
import type { Database } from '@shared/types/database';
import { DayTabSelector } from '@member/components/DayTabSelector';
import { ClaseRow } from '@member/components/ClaseRow';
import { ConfirmarReservaModal } from '@member/components/ConfirmarReservaModal';
import { ConfirmarCancelacionModal } from '@member/components/ConfirmarCancelacionModal';

type ClaseRowDB = Database['public']['Tables']['clases']['Row'];
type RecursoMinDB = Pick<
  Database['public']['Tables']['recursos']['Row'],
  'id' | 'nombre' | 'foto_url' | 'tiers_permitidos'
>;
interface ClaseConRecurso extends ClaseRowDB {
  recurso: RecursoMinDB | null;
}

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

  // S4.2: traemos las clases programadas del día desde la tabla `clases`.
  // misReservasIds: clase_id → reserva.id del usuario (para cancelar inline).
  // cuposPorClase: clase_id → count de reservas activas.
  const [clasesRaw, setClasesRaw] = useState<ClaseConRecurso[]>([]);
  const [cuposPorClase, setCuposPorClase] = useState<Map<string, number>>(new Map());
  const [misReservasIds, setMisReservasIds] = useState<Map<string, string>>(new Map());
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

  // S4.2: cargar clases del día (tabla real) + cupos + mis reservas
  useEffect(() => {
    if (!fechaSel || !usuario) return;
    let mounted = true;
    setLoadingDia(true);

    async function load() {
      const clasesRes = await supabase
        .from('clases')
        .select('*, recurso:recursos(id, nombre, foto_url, tiers_permitidos)')
        .eq('tenant_id', tenant.id)
        .eq('fecha', fechaSel)
        .eq('status', 'programada')
        .order('hora_inicio', { ascending: true });

      if (!mounted) return;

      const filas = (clasesRes.data ?? []) as ClaseConRecurso[];
      const claseIds = filas.map((c) => c.id);

      const [cuposRes, misRes] = claseIds.length === 0
        ? [{ data: [] as Array<{ clase_id: string | null }> }, { data: [] as Array<{ id: string; clase_id: string | null }> }]
        : await Promise.all([
            supabase
              .from('reservas')
              .select('clase_id')
              .in('clase_id', claseIds)
              .in('status', ['confirmada', 'completada']),
            supabase
              .from('reservas')
              .select('id, clase_id')
              .eq('usuario_id', usuario!.id)
              .in('clase_id', claseIds)
              .in('status', ['confirmada', 'completada'])
          ]);

      if (!mounted) return;

      const cuposMap = new Map<string, number>();
      for (const r of (cuposRes.data ?? []) as Array<{ clase_id: string | null }>) {
        if (!r.clase_id) continue;
        cuposMap.set(r.clase_id, (cuposMap.get(r.clase_id) ?? 0) + 1);
      }
      const misMap = new Map<string, string>();
      for (const r of (misRes.data ?? []) as Array<{ id: string; clase_id: string | null }>) {
        if (r.clase_id) misMap.set(r.clase_id, r.id);
      }

      setClasesRaw(filas);
      setCuposPorClase(cuposMap);
      setMisReservasIds(misMap);
      setLoadingDia(false);
    }
    void load();
    return () => { mounted = false; };
  }, [fechaSel, tenant.id, usuario, refreshTick]);

  // Mapear las clases a la interfaz UI, aplicando filtro de sala y "ya pasó" si es hoy.
  const clases = useMemo<Clase[]>(() => {
    if (clasesRaw.length === 0) return [];
    const filasFiltradas =
      salaSel === SALA_TODAS ? clasesRaw : clasesRaw.filter((c) => c.recurso_id === salaSel);

    const mapped = filasFiltradas.map((row) => {
      const recurso = row.recurso
        ? {
            id: row.recurso.id,
            nombre: row.recurso.nombre,
            foto_url: row.recurso.foto_url,
            tiers_permitidos: row.recurso.tiers_permitidos
          }
        : { id: row.recurso_id, nombre: '—' };
      return claseFromRow({
        row,
        cuposReservados: cuposPorClase.get(row.id) ?? 0,
        recurso
      });
    });

    const hoy = new Date();
    const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    const esHoy = fechaSel === inicioHoy.toISOString().slice(0, 10);
    if (!esHoy) return mapped;
    const ahora = Date.now();
    return mapped.filter((c) => c.slotInicio.getTime() >= ahora);
  }, [clasesRaw, cuposPorClase, salaSel, fechaSel]);

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
        claseId: claseAReservar.id,
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
    const reservaId = misReservasIds.get(claseACancelar.id);
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
            const yaReservada = misReservasIds.has(clase.id);
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
