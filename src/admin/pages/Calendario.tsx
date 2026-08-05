import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useReservasRango, useRecursosAdmin } from '../hooks/useAdminData';
import { useSucursal } from '../providers/SucursalProvider';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone, hoyEnTimezone, sumarDias, fechaEnTz, formatHoraEnTz } from '@shared/lib/timezone';
import { fromZonedTime } from 'date-fns-tz';
import DetalleReservaModal from '../components/DetalleReservaModal';
import CancelarReservaModal, {
  type ReservaParaCancelar
} from '../components/CancelarReservaModal';
import ReservasVistaLista from '../components/ReservasVistaLista';

type Vista = 'calendario' | 'lista';
const STORAGE_KEY = 'sala-admin-reservas-vista';

function readVista(): Vista {
  if (typeof localStorage === 'undefined') return 'calendario';
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'lista' ? 'lista' : 'calendario';
}

export default function Calendario() {
  const [vista, setVista] = useState<Vista>(() => readVista());
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [paraCancelar, setParaCancelar] = useState<ReservaParaCancelar | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, vista);
    } catch {
      // ignore
    }
  }, [vista]);

  const handleCancelado = () => {
    setRefreshTick((t) => t + 1);
  };

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: '16px',
          flexWrap: 'wrap'
        }}
      >
        <div>
          <p className="ek-eyebrow">RESERVAS</p>
          <h1 className="ek-h2">Gestiona reservas de tus miembros</h1>
        </div>
        <VistaToggle value={vista} onChange={setVista} />
      </div>

      {vista === 'calendario' ? (
        <VistaCalendario refreshTick={refreshTick} onVerDetalle={setDetalleId} />
      ) : (
        <ReservasVistaLista
          refreshTick={refreshTick}
          onVerDetalle={setDetalleId}
          onCancelar={setParaCancelar}
        />
      )}

      <DetalleReservaModal
        reservaId={detalleId}
        onClose={() => setDetalleId(null)}
        onCancelar={(info) => {
          setDetalleId(null);
          setParaCancelar(info);
        }}
      />

      {paraCancelar && (
        <CancelarReservaModal
          reserva={paraCancelar}
          onClose={() => setParaCancelar(null)}
          onCancelled={() => {
            setParaCancelar(null);
            handleCancelado();
          }}
        />
      )}
    </div>
  );
}

function VistaToggle({ value, onChange }: { value: Vista; onChange: (v: Vista) => void }) {
  const baseBtn: React.CSSProperties = {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 600,
    background: 'transparent',
    color: 'var(--ek-ink-muted)',
    border: 'none',
    cursor: 'pointer',
    transition: 'background 0.18s ease, color 0.18s ease',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px'
  };
  const activeBtn: React.CSSProperties = {
    background: 'var(--sala-accent)',
    color: 'var(--sala-accent-text)'
  };
  return (
    <div
      role="group"
      aria-label="Cambiar vista"
      style={{
        display: 'inline-flex',
        border: '0.5px solid var(--ek-line)',
        borderRadius: 'var(--ek-r-md)',
        overflow: 'hidden'
      }}
    >
      <button
        type="button"
        onClick={() => onChange('calendario')}
        aria-pressed={value === 'calendario'}
        style={{ ...baseBtn, ...(value === 'calendario' ? activeBtn : {}) }}
      >
        📅 Calendario
      </button>
      <button
        type="button"
        onClick={() => onChange('lista')}
        aria-pressed={value === 'lista'}
        style={{ ...baseBtn, ...(value === 'lista' ? activeBtn : {}) }}
      >
        ☰ Lista
      </button>
    </div>
  );
}

// ============================================================================
// Vista Calendario semanal (la existente, ahora con click en cards)
// ============================================================================

function VistaCalendario({
  refreshTick,
  onVerDetalle
}: {
  refreshTick: number;
  onVerDetalle: (id: string) => void;
}) {
  const tz = getTenantTimezone(useTenant());
  const { recursos } = useRecursosAdmin();
  const { sucursalId } = useSucursal();

  // Semana en la zona del GYM: el lunes como 'YYYY-MM-DD' del gym. Así, mire desde
  // donde mire (p. ej. España), los días y horas son los del gym, no del navegador.
  const [weekStart, setWeekStart] = useState<string>(() => lunesDeLaSemana(hoyEnTimezone(tz)));
  const weekEndISO = useMemo(() => sumarDias(weekStart, 7), [weekStart]);

  // Rango [lunes, lunes+7) como instantes UTC de la medianoche del gym.
  const desde = useMemo(() => fromZonedTime(`${weekStart}T00:00:00`, tz), [weekStart, tz]);
  const hasta = useMemo(() => fromZonedTime(`${weekEndISO}T00:00:00`, tz), [weekEndISO, tz]);
  const { reservas, isLoading, refetch } = useReservasRango(desde, hasta, sucursalId);

  useEffect(() => {
    if (refreshTick > 0) void refetch();
    // refetch identity changes across renders, lo usamos solo cuando sube tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => sumarDias(weekStart, i)),
    [weekStart]
  );

  // La sala solo se muestra si VARÍA entre las reservas: un gym de una sola sala
  // no repite "Sala Numa" en cada evento; uno multi-sala sí la muestra.
  const mostrarSala = useMemo(
    () => new Set(reservas.map((r) => r.recurso?.id).filter(Boolean)).size > 1,
    [reservas]
  );

  return (
    <>
      <div className="adm-week-nav">
        <button
          onClick={() => setWeekStart((w) => sumarDias(w, -7))}
          className="adm-link-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
        >
          <ChevronLeft size={16} strokeWidth={2.25} />
          Semana anterior
        </button>
        <span className="adm-week-label">
          {etiquetaRango(weekStart, sumarDias(weekStart, 6))}
        </span>
        <button
          onClick={() => setWeekStart((w) => sumarDias(w, 7))}
          className="adm-link-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
        >
          Semana siguiente
          <ChevronRight size={16} strokeWidth={2.25} />
        </button>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <div className="adm-cal-grid">
          {days.map((diaISO) => {
            const reservasDelDia = reservas.filter(
              (r) => fechaEnTz(new Date(r.slot_inicio), tz) === diaISO
            );
            const [yy, mm, dd] = diaISO.split('-').map(Number);
            const etiqueta = new Date(Date.UTC(yy, mm - 1, dd, 12));
            return (
              <div key={diaISO} className="adm-cal-day">
                <div className="adm-cal-day-header">
                  <p className="adm-cal-day-name">
                    {etiqueta.toLocaleDateString('es-MX', { weekday: 'short', timeZone: 'UTC' })}
                  </p>
                  <p className="adm-cal-day-num">{dd}</p>
                </div>
                <div className="adm-cal-events">
                  {reservasDelDia.length === 0 && <p className="adm-cal-empty">—</p>}
                  {reservasDelDia.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onVerDetalle(r.id)}
                      className="adm-cal-event"
                      data-status={r.status}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        font: 'inherit',
                        color: 'inherit',
                        padding: 0
                      }}
                    >
                      <p className="adm-cal-event-time">
                        {formatHoraEnTz(new Date(r.slot_inicio), tz)}
                      </p>
                      {mostrarSala && <p className="adm-cal-event-recurso">{r.recurso?.nombre ?? '—'}</p>}
                      <p className="adm-cal-event-usuario">
                        {r.usuario?.nombre ?? r.usuario?.email ?? '—'}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="adm-cal-legend">
        <p style={{ fontSize: '0.75rem', color: 'var(--ek-ink-muted)' }}>
          Total salas: {recursos.length} · Reservas en rango: {reservas.length}
        </p>
      </div>
    </>
  );
}

/** Lunes (YYYY-MM-DD) de la semana que contiene `iso`, en fechas de calendario. */
function lunesDeLaSemana(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=dom..6=sab
  return sumarDias(iso, dow === 0 ? -6 : 1 - dow);
}

/** "3 ago — 9 ago 2026" a partir de dos fechas 'YYYY-MM-DD'. */
function etiquetaRango(aISO: string, bISO: string): string {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-MX', { ...opts, timeZone: 'UTC' });
  };
  return `${fmt(aISO, { day: 'numeric', month: 'short' })} — ${fmt(bISO, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
