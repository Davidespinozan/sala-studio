import { useState, useMemo } from 'react';
import { useReservasHoy, checkInManual, type ReservaConJoin } from '../hooks/useReservasHoy';

interface Props {
  onManualCheckInSuccess?: (data: any) => void;
}

function capitalizarNombre(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatearDia(fecha: Date): string {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const target = new Date(fecha);
  target.setHours(0, 0, 0, 0);

  const diffDias = Math.round((target.getTime() - hoy.getTime()) / 86400000);

  if (diffDias === 0) return 'Hoy';
  if (diffDias === 1) return 'Mañana';
  if (diffDias === -1) return 'Ayer';

  return target.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'short'
  });
}

export function ReservasHoyView({ onManualCheckInSuccess }: Props = {}) {
  const [fechaSeleccionada, setFechaSeleccionada] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const { reservas, isLoading, refetch } = useReservasHoy(fechaSeleccionada);
  const [selected, setSelected] = useState<ReservaConJoin | null>(null);

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const esHoy = fechaSeleccionada.getTime() === hoy.getTime();

  const cambiarDia = (delta: number) => {
    const nueva = new Date(fechaSeleccionada);
    nueva.setDate(nueva.getDate() + delta);
    setFechaSeleccionada(nueva);
  };

  const { llegando, resto } = useMemo(() => {
    const now = Date.now();
    const llegando: ReservaConJoin[] = [];
    const resto: ReservaConJoin[] = [];
    reservas.forEach((r) => {
      const inicio = new Date(r.slot_inicio).getTime();
      const fin = new Date(r.slot_fin).getTime();
      // "Llegando ahora" solo aplica si la fecha vista es hoy
      if (
        esHoy &&
        ((now >= inicio - 15 * 60_000 && now <= fin) ||
          (now >= inicio - 15 * 60_000 && now <= inicio + 15 * 60_000))
      ) {
        llegando.push(r);
      } else {
        resto.push(r);
      }
    });
    return { llegando, resto };
  }, [reservas, esHoy]);

  if (isLoading) {
    return (
      <p style={{ color: 'var(--ek-ink-muted)', textAlign: 'center', marginTop: '2rem' }}>
        Cargando agenda…
      </p>
    );
  }

  return (
    <div className="rec-hoy" style={{ paddingBottom: '110px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px',
          padding: '6px',
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-md)'
        }}
      >
        <button
          onClick={() => cambiarDia(-1)}
          className="ek-icon-btn"
          aria-label="Día anterior"
          style={{ width: '40px', height: '40px', padding: 0 }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div style={{ textAlign: 'center', flex: 1 }}>
          <p className="ek-eyebrow" style={{ marginBottom: '2px', fontSize: '9px' }}>
            VISTA DEL DÍA
          </p>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '16px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              margin: 0,
              textTransform: 'capitalize'
            }}
          >
            {formatearDia(fechaSeleccionada)}
          </p>
        </div>

        <button
          onClick={() => cambiarDia(1)}
          className="ek-icon-btn"
          aria-label="Día siguiente"
          style={{ width: '40px', height: '40px', padding: 0 }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      <section style={{ marginBottom: '32px', marginTop: '24px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '12px' }}>
          LLEGANDO AHORA
        </p>
        {llegando.length === 0 ? (
          <p className="ek-body-faint" style={{ padding: '12px 0' }}>
            No hay reservas próximas a llegar.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {llegando.map((r) => (
              <ReservaCard key={r.id} reserva={r} onSelect={setSelected} highlight />
            ))}
          </div>
        )}
      </section>

      <section>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>
          {esHoy ? 'RESTO DEL DÍA' : 'RESERVAS DEL DÍA'}
        </p>
        {resto.length === 0 ? (
          <p className="ek-body-faint" style={{ padding: '12px 0' }}>
            {esHoy ? 'No hay más reservas para este día.' : 'No hay reservas para este día.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {resto.map((r) => (
              <ReservaCard key={r.id} reserva={r} onSelect={setSelected} />
            ))}
          </div>
        )}
      </section>

      {selected && (
        <ManualCheckInModal
          reserva={selected}
          onClose={() => setSelected(null)}
          onDone={async (data) => {
            await refetch();
            setSelected(null);
            onManualCheckInSuccess?.(data);
          }}
        />
      )}
    </div>
  );
}

function ReservaCard({
  reserva,
  onSelect,
  highlight
}: {
  reserva: ReservaConJoin;
  onSelect: (r: ReservaConJoin) => void;
  highlight?: boolean;
}) {
  const hora = new Date(reserva.slot_inicio).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const nombreFormat =
    capitalizarNombre(reserva.usuario?.nombre) || reserva.usuario?.email || '—';

  const tier = reserva.usuario?.membresia_tier;
  const disabled = reserva.status === 'cancelada' || reserva.status === 'no_show';

  const statusConfig: Record<
    string,
    { label: string; bg: string; color: string }
  > = {
    confirmada: {
      label: 'PENDIENTE',
      bg: 'var(--ek-mustard)',
      color: 'var(--ek-bg)'
    },
    completada: {
      label: '✓ OK',
      bg: 'var(--ek-success-soft)',
      color: 'var(--ek-success)'
    },
    cancelada: {
      label: 'CANCELADA',
      bg: 'var(--ek-danger-soft)',
      color: 'var(--ek-danger)'
    },
    no_show: {
      label: 'NO SHOW',
      bg: 'var(--ek-danger-soft)',
      color: 'var(--ek-danger)'
    }
  };

  const status = statusConfig[reserva.status] ?? statusConfig.confirmada;

  return (
    <button
      onClick={() => onSelect(reserva)}
      disabled={disabled}
      className="ek-card ek-card-interactive"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '16px 18px',
        textAlign: 'left',
        background: 'var(--ek-bg-soft)',
        border: highlight
          ? '0.5px solid var(--ek-mustard-dim)'
          : '0.5px solid var(--ek-line)',
        borderRadius: 'var(--ek-r-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        font: 'inherit',
        color: 'inherit',
        width: '100%',
        opacity: disabled ? 0.55 : 1,
        boxShadow: highlight ? '0 0 0 1px var(--ek-mustard-dim)' : 'none'
      }}
    >
      <div
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '22px',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: 'var(--ek-ink)',
          minWidth: '70px'
        }}
      >
        {hora}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '16px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '4px',
            color: 'var(--ek-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {nombreFormat}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>
          {reserva.recurso?.nombre ?? '—'}
          {tier && ` · ${tier}`}
        </p>
      </div>

      <span
        className="ek-badge"
        style={{
          backgroundColor: status.bg,
          color: status.color,
          fontSize: '10px',
          fontWeight: 700,
          flexShrink: 0
        }}
      >
        {status.label}
      </span>
    </button>
  );
}

function ManualCheckInModal({
  reserva,
  onClose,
  onDone
}: {
  reserva: ReservaConJoin;
  onClose: () => void;
  onDone: (data: any) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const yaCheckIn = reserva.status === 'completada';

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await checkInManual(reserva.id, motivo.trim() || undefined);
      await onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error en check-in');
      setSubmitting(false);
    }
  }

  const hora = new Date(reserva.slot_inicio).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const nombreFormat =
    capitalizarNombre(reserva.usuario?.nombre) || reserva.usuario?.email || '—';

  return (
    <div className="rec-modal-backdrop" onClick={() => !submitting && onClose()}>
      <div className="rec-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow ek-eyebrow--mustard">
          {yaCheckIn ? 'CHECK-IN COMPLETADO' : 'CHECK-IN MANUAL'}
        </p>
        <h3
          style={{
            color: 'var(--ek-ink)',
            fontFamily: 'var(--ek-font-display)',
            fontSize: '1.5rem',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            marginTop: '0.25rem'
          }}
        >
          {nombreFormat}
        </h3>
        <p style={{ color: 'var(--ek-ink-muted)', marginTop: '0.25rem' }}>
          {reserva.recurso?.nombre} · {hora}
        </p>

        {yaCheckIn ? (
          <>
            <p style={{ color: 'var(--ek-success)', marginTop: '1rem', fontWeight: 600 }}>
              ✓ Ya hizo check-in
              {(() => {
                const m = (reserva as { check_in_method?: string }).check_in_method;
                return m ? ` (${m})` : null;
              })()}
            </p>
            <button onClick={onClose} className="ek-cta ek-cta--full" style={{ marginTop: '1rem' }}>
              Cerrar
            </button>
          </>
        ) : (
          <>
            <label style={{ display: 'block', marginTop: '1.25rem' }}>
              <span className="ek-eyebrow" style={{ color: 'var(--ek-ink-muted)' }}>
                MOTIVO (OPCIONAL)
              </span>
              <input
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej. olvidó su celular"
                className="ek-input"
                style={{ marginTop: '0.5rem' }}
              />
            </label>

            {error && (
              <p style={{ color: 'var(--ek-danger)', marginTop: '1rem', fontSize: '0.875rem' }}>
                {error}
              </p>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
              <button
                onClick={onClose}
                disabled={submitting}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1 }}
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirm}
                disabled={submitting}
                className="ek-cta"
                style={{ flex: 1 }}
              >
                {submitting ? 'Marcando…' : 'Marcar check-in'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
