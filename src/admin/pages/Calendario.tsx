import { useEffect, useMemo, useState } from 'react';
import { useReservasRango, useRecursosAdmin } from '../hooks/useAdminData';
import { formatHora } from '@member/logic/reservaLogic';
import DetalleReservaModal from '../components/DetalleReservaModal';
import CancelarReservaModal, {
  type ReservaParaCancelar
} from '../components/CancelarReservaModal';
import ReservasVistaLista from '../components/ReservasVistaLista';

type Vista = 'calendario' | 'lista';
const STORAGE_KEY = 'ekko-admin-reservas-vista';

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
    background: 'var(--ek-mustard)',
    color: 'var(--ek-bg)'
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
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const weekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 7);
    return d;
  }, [weekStart]);

  const { recursos } = useRecursosAdmin();
  const { reservas, isLoading, refetch } = useReservasRango(weekStart, weekEnd);

  useEffect(() => {
    if (refreshTick > 0) void refetch();
    // refetch identity changes across renders, lo usamos solo cuando sube tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const days = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, [weekStart]);

  return (
    <>
      <div className="adm-week-nav">
        <button
          onClick={() => setWeekStart(addDays(weekStart, -7))}
          className="adm-link-btn"
        >
          ← Semana anterior
        </button>
        <span className="adm-week-label">
          {weekStart.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} —{' '}
          {addDays(weekStart, 6).toLocaleDateString('es-MX', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
          })}
        </span>
        <button
          onClick={() => setWeekStart(addDays(weekStart, 7))}
          className="adm-link-btn"
        >
          Semana siguiente →
        </button>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <div className="adm-cal-grid">
          {days.map((day) => {
            const reservasDelDia = reservas.filter((r) =>
              sameDay(new Date(r.slot_inicio), day)
            );
            return (
              <div key={day.toISOString()} className="adm-cal-day">
                <div className="adm-cal-day-header">
                  <p className="adm-cal-day-name">
                    {day.toLocaleDateString('es-MX', { weekday: 'short' })}
                  </p>
                  <p className="adm-cal-day-num">{day.getDate()}</p>
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
                        {formatHora(new Date(r.slot_inicio))}
                      </p>
                      <p className="adm-cal-event-recurso">{r.recurso?.nombre ?? '—'}</p>
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
          Total recursos: {recursos.length} · Reservas en rango: {reservas.length}
        </p>
      </div>
    </>
  );
}

function startOfWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day; // semana inicia en lunes
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
