import { useState, useMemo, useEffect, type ReactNode } from 'react';
import { Check, CalendarClock, CalendarDays, Clock, Hourglass, TrendingUp, Layers, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone, hoyEnTimezone, sumarDias, diasEntre, formatHoraEnTz } from '@shared/lib/timezone';
import { useReservasHoy, checkInManual, cobrarMultaReserva, type ReservaConJoin } from '../hooks/useReservasHoy';
import { formatearMoneda } from '@shared/lib/dinero';
import { playCheckInSuccess, playCheckInError } from '../lib/checkInFeedback';
import { EmptyState } from '@shared/components/EmptyState';
import { esCorreoMarcador } from '@shared/lib/sinCorreo';
import { CancelarReservaModal } from './acciones/CancelarReservaModal';
import { MarcarNoShowModal } from './acciones/MarcarNoShowModal';
import { MarcarAsistioModal } from './acciones/MarcarAsistioModal';
import { CorregirCheckinModal } from './acciones/CorregirCheckinModal';
import { MapaClaseModal } from './acciones/MapaClaseModal';

type AccionReserva = 'cancelar' | 'no_show' | 'corregir' | 'mapa' | 'marcar_asistio';

interface Props {
  onManualCheckInSuccess?: (data: any) => void;
  /** Avisa al Scanner cuando hay un modal abierto, para pausar el lector HID
   *  (si no, un escaneo dispara el overlay de check-in por detrás del modal). */
  onModalOpenChange?: (open: boolean) => void;
}

// Persistencia del día visto: si el recepcionista cambia de día, F5 no lo
// resetea. Se ignora si lo guardado tiene > 7 días (no abrir una vista vieja).
const FECHA_KEY = 'sala-recepcion-hoy-fecha';
const FECHA_TTL_MS = 7 * 86400000;

/** El día visto se guarda como 'YYYY-MM-DD' en la zona del gym. */
function leerFechaGuardada(tz: string): string {
  const hoy = hoyEnTimezone(tz);
  try {
    const raw = localStorage.getItem(FECHA_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { value?: string; savedAt?: number };
      if (
        typeof parsed.value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.value) &&
        typeof parsed.savedAt === 'number' &&
        Date.now() - parsed.savedAt <= FECHA_TTL_MS
      ) {
        return parsed.value;
      }
    }
  } catch {
    // localStorage no disponible / JSON inválido → default hoy
  }
  return hoy;
}

function guardarFecha(diaISO: string): void {
  try {
    localStorage.setItem(FECHA_KEY, JSON.stringify({ value: diaISO, savedAt: Date.now() }));
  } catch {
    // private mode / quota → no-op
  }
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

/** `diaISO` y `hoyISO` son 'YYYY-MM-DD' en la zona del gym. */
function formatearDia(diaISO: string, hoyISO: string): string {
  const diffDias = diasEntre(hoyISO, diaISO);

  if (diffDias === 0) return 'Hoy';
  if (diffDias === 1) return 'Mañana';
  if (diffDias === -1) return 'Ayer';

  // Mediodía UTC de las partes de fecha: solo se leen día/mes/semana, sin cruce.
  const [y, m, d] = diaISO.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC'
  });
}

export function ReservasHoyView({ onManualCheckInSuccess, onModalOpenChange }: Props = {}) {
  const tz = getTenantTimezone(useTenant());
  // El día visto es 'YYYY-MM-DD' en la zona del gym: si el dueño mira desde otra
  // zona (p. ej. España), "Hoy" sigue siendo el día del gym, no el del navegador.
  const [fechaSeleccionada, setFechaSeleccionada] = useState<string>(() => leerFechaGuardada(tz));
  const { reservas, isLoading, refetch } = useReservasHoy(fechaSeleccionada);
  const [selected, setSelected] = useState<ReservaConJoin | null>(null);
  const [accionReserva, setAccionReserva] = useState<AccionReserva | null>(null);
  const [restoTab, setRestoTab] = useState<'pendientes' | 'asistieron' | 'no_show' | 'canceladas'>('pendientes');

  // Hay un modal abierto (check-in manual o acción) sii hay una reserva
  // seleccionada. Le avisamos al Scanner para que pause el lector HID.
  useEffect(() => {
    onModalOpenChange?.(selected !== null);
  }, [selected, onModalOpenChange]);

  // Persistir el día visto cada vez que cambia.
  useEffect(() => {
    guardarFecha(fechaSeleccionada);
  }, [fechaSeleccionada]);

  const hoyISO = hoyEnTimezone(tz);
  const esHoy = fechaSeleccionada === hoyISO;

  const cambiarDia = (delta: number) => {
    setFechaSeleccionada((actual) => sumarDias(actual, delta));
  };

  const { llegando, resto, kpis } = useMemo(() => {
    const now = Date.now();
    const llegando: ReservaConJoin[] = [];
    const resto: ReservaConJoin[] = [];
    reservas.forEach((r) => {
      const inicio = new Date(r.slot_inicio).getTime();
      const fin = new Date(r.slot_fin).getTime();
      // "Llegando ahora" solo aplica si la fecha vista es hoy Y la reserva sigue
      // CONFIRMADA (pendiente de check-in). Sin el filtro de status, una reserva
      // cancelada/asistida caía en "llegando" con botón de check-in (fantasmas).
      if (
        esHoy &&
        r.status === 'confirmada' &&
        ((now >= inicio - 15 * 60_000 && now <= fin) ||
          (now >= inicio - 15 * 60_000 && now <= inicio + 15 * 60_000))
      ) {
        llegando.push(r);
      } else {
        resto.push(r);
      }
    });
    // Indicadores del día, derivados de las mismas reservas (sin queries extra).
    const activos = reservas.filter((r) => r.status !== 'cancelada');
    const completadas = activos.filter((r) => r.status === 'completada').length;
    const pendientes = reservas.filter((r) => r.status === 'confirmada').length;
    const total = activos.length;
    const clases = new Set(activos.map((r) => `${r.recurso?.id ?? '·'}-${r.slot_inicio}`)).size;
    const kpis = {
      total,
      llegando: llegando.length,
      pendientes,
      completadas,
      asistencia: total > 0 ? Math.round((completadas / total) * 100) : 0,
      clases
    };
    return { llegando, resto, kpis };
  }, [reservas, esHoy]);

  // "Resto del día" separado por estado, para las pestañas.
  const restoBuckets = useMemo(() => ({
    pendientes: resto.filter((r) => r.status === 'confirmada'),
    asistieron: resto.filter((r) => r.status === 'completada'),
    no_show: resto.filter((r) => r.status === 'no_show'),
    canceladas: resto.filter((r) => r.status === 'cancelada')
  }), [resto]);
  const restoTabs = ([
    ['pendientes', 'Pendientes'],
    ['asistieron', 'Asistieron'],
    ['no_show', 'No llegaron'],
    ['canceladas', 'Canceladas']
  ] as const).filter(([k]) => restoBuckets[k].length > 0);
  const restoActiva = restoBuckets[restoTab].length > 0 ? restoTab : (restoTabs[0]?.[0] ?? 'pendientes');

  // La sala solo se muestra si VARÍA entre las reservas: un gym de una sola sala
  // no repite "Sala Numa" en cada tarjeta; uno multi-sala sí la muestra.
  const mostrarSala = new Set(reservas.map((r) => r.recurso?.id).filter(Boolean)).size > 1;

  // Check-in rápido (1 toque) desde la tarjeta de "Llegando ahora". Misma acción
  // que el modal — si falla (ventana/ya hecho), abre el modal para ver el detalle.
  async function quickCheckIn(r: ReservaConJoin) {
    try {
      const result = await checkInManual(r.id);
      playCheckInSuccess();
      await refetch();
      onManualCheckInSuccess?.(result);
    } catch {
      playCheckInError();
      setSelected(r);
    }
  }

  if (isLoading) {
    return (
      <p style={{ color: 'var(--ek-ink-muted)', textAlign: 'center', marginTop: '2rem' }}>
        Cargando agenda…
      </p>
    );
  }

  return (
    <div className="rec-hoy" style={{ paddingBottom: '110px' }}>
      {/* Selector de día — barra compacta */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <button
          onClick={() => cambiarDia(-1)}
          className="ek-icon-btn"
          aria-label="Día anterior"
          style={{ width: '38px', height: '38px', padding: 0, flexShrink: 0 }}
        >
          <ChevronLeft size={18} strokeWidth={2.5} />
        </button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <span
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '17px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              textTransform: 'capitalize',
              color: 'var(--sala-text-primary)'
            }}
          >
            {formatearDia(fechaSeleccionada, hoyISO)}
          </span>
        </div>
        <button
          onClick={() => cambiarDia(1)}
          className="ek-icon-btn"
          aria-label="Día siguiente"
          style={{ width: '38px', height: '38px', padding: 0, flexShrink: 0 }}
        >
          <ChevronRight size={18} strokeWidth={2.5} />
        </button>
      </div>

      {/* Indicadores del día — protagonismo visual */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '12px',
          marginBottom: '22px'
        }}
      >
        <KpiTile label="Reservas" value={kpis.total} hint={esHoy ? 'del día' : 'ese día'} icon={<CalendarDays size={15} strokeWidth={2} />} />
        <KpiTile label="Llegando ahora" value={kpis.llegando} hint="en ventana" icon={<Clock size={15} strokeWidth={2} />} accent={esHoy && kpis.llegando > 0} />
        <KpiTile label="Pendientes" value={kpis.pendientes} hint="por check-in" icon={<Hourglass size={15} strokeWidth={2} />} accent={kpis.pendientes > 0} />
        <KpiTile label="Asistencia" value={`${kpis.asistencia}%`} hint={`${kpis.completadas} check-ins`} icon={<TrendingUp size={15} strokeWidth={2} />} />
        <KpiTile label="Clases" value={kpis.clases} hint="activas" icon={<Layers size={15} strokeWidth={2} />} />
      </div>

      {/* Llegando ahora — bloque principal */}
      <section style={{ marginBottom: '26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>LLEGANDO AHORA</p>
          {llegando.length > 0 && (
            <span
              style={{
                fontSize: '11px', fontWeight: 800, color: 'var(--sala-accent)',
                background: 'color-mix(in srgb, var(--sala-accent) 14%, transparent)',
                borderRadius: '999px', padding: '2px 9px', lineHeight: 1.4
              }}
            >
              {llegando.length}
            </span>
          )}
        </div>
        {llegando.length === 0 ? (
          <div
            style={{
              padding: '22px', textAlign: 'center', borderRadius: '16px',
              border: '1px dashed var(--sala-border)', background: 'var(--sala-surface)',
              fontSize: '13px', color: 'var(--sala-text-tertiary)'
            }}
          >
            Sin llegadas en este momento.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {llegando.map((r) => (
              <LlegandoCard key={r.id} reserva={r} tz={tz} mostrarSala={mostrarSala} onSelect={setSelected} onQuickCheckIn={quickCheckIn} />
            ))}
          </div>
        )}
      </section>

      {/* Resto del día */}
      <section>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>
          {esHoy ? 'RESTO DEL DÍA' : 'RESERVAS DEL DÍA'}
        </p>
        {resto.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={esHoy ? 'No hay más reservas para este día.' : 'No hay reservas para este día.'}
            subtitle={esHoy ? 'Vuelve en un rato para ver nuevas llegadas.' : 'Prueba con otro día desde el selector de arriba.'}
          />
        ) : (
          <>
            {restoTabs.length > 1 && (
              <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                {restoTabs.map(([k, label]) => {
                  const activo = k === restoActiva;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setRestoTab(k)}
                      style={{
                        minHeight: '36px', padding: '0 14px', borderRadius: '999px',
                        border: `1px solid ${activo ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
                        background: activo ? 'var(--sala-primary)' : 'var(--sala-surface)',
                        color: activo ? '#fff' : 'var(--sala-text-secondary)',
                        fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: '6px'
                      }}
                    >
                      {label}
                      <span style={{ fontSize: '11px', fontWeight: 700, opacity: 0.85 }}>{restoBuckets[k].length}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {restoBuckets[restoActiva].map((r) => (
                <ReservaCard key={r.id} reserva={r} tz={tz} mostrarSala={mostrarSala} onSelect={setSelected} />
              ))}
            </div>
          </>
        )}
      </section>

      {selected && !accionReserva && (
        <ManualCheckInModal
          reserva={selected}
          tz={tz}
          onClose={() => setSelected(null)}
          onAccion={(tipo) => setAccionReserva(tipo)}
          onDone={async (data) => {
            await refetch();
            setSelected(null);
            onManualCheckInSuccess?.(data);
          }}
        />
      )}

      {selected && accionReserva && (() => {
        const horaSel = formatHoraEnTz(new Date(selected.slot_inicio), tz);
        const nombreSel = capitalizarNombre(selected.usuario?.nombre) || selected.usuario?.email || '—';
        const label = `${selected.recurso?.nombre ?? 'Clase'} · ${horaSel} · ${nombreSel}`;
        const volver = () => setAccionReserva(null); // vuelve al modal de la reserva
        const hecho = async () => {
          await refetch();
          setSelected(null);
          setAccionReserva(null);
        };
        if (accionReserva === 'mapa') return <MapaClaseModal reserva={selected} onClose={hecho} />;
        const props = { reservaId: selected.id, reservaLabel: label, isOpen: true, onClose: volver, onDone: hecho };
        if (accionReserva === 'cancelar') return <CancelarReservaModal {...props} />;
        if (accionReserva === 'no_show') return <MarcarNoShowModal {...props} />;
        if (accionReserva === 'marcar_asistio') return <MarcarAsistioModal {...props} />;
        return <CorregirCheckinModal {...props} />;
      })()}
    </div>
  );
}

function iniciales(n: string | undefined | null): string {
  const t = (n ?? '').trim().split(/\s+/).filter(Boolean);
  return ((t[0]?.[0] ?? '?') + (t[1]?.[0] ?? '')).toUpperCase();
}

function Avatar({ url, nombre, size = 44 }: { url?: string | null; nombre?: string | null; size?: number }) {
  if (url) {
    return (
      <img src={url} alt="" loading="lazy"
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        background: 'var(--sala-primary-light)', color: 'var(--sala-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--ek-font-display)', fontWeight: 700, fontSize: Math.round(size * 0.34)
      }}
    >
      {iniciales(nombre)}
    </span>
  );
}

function KpiTile({ label, value, hint, icon, accent = false }: {
  label: string; value: string | number; hint?: string; icon: ReactNode; accent?: boolean;
}) {
  return (
    <div
      style={{
        position: 'relative', overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '94px',
        padding: '14px 16px', borderRadius: '16px',
        background: accent
          ? 'linear-gradient(160deg, color-mix(in srgb, var(--ek-mustard) 11%, var(--sala-surface)), var(--sala-surface))'
          : 'linear-gradient(165deg, var(--sala-surface), color-mix(in srgb, var(--sala-surface) 86%, var(--sala-bg)))',
        border: `1px solid ${accent ? 'color-mix(in srgb, var(--ek-mustard) 36%, var(--sala-border))' : 'var(--sala-border)'}`,
        boxShadow: '0 1px 2px rgba(10, 15, 12, 0.04), 0 8px 22px rgba(10, 15, 12, 0.05)'
      }}
    >
      {accent && (
        <span aria-hidden="true"
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '3px', background: 'var(--ek-mustard)' }} />
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '9.5px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--sala-text-tertiary)' }}>
          {label}
        </span>
        <span style={{ display: 'inline-flex', color: accent ? 'var(--ek-mustard)' : 'var(--sala-text-tertiary)' }}>{icon}</span>
      </div>
      <div style={{ fontFamily: 'var(--ek-font-display)', fontSize: '30px', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, color: 'var(--sala-text-primary)' }}>
        {value}
      </div>
      {hint && <span style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)' }}>{hint}</span>}
    </div>
  );
}

function TierChip({ tier }: { tier: string | null | undefined }) {
  if (!tier) return null;
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
      color: 'var(--sala-primary)', background: 'var(--sala-primary-light)',
      borderRadius: '999px', padding: '2px 8px', lineHeight: 1.5, flexShrink: 0
    }}>
      {tier}
    </span>
  );
}

/** Tarjeta principal de "Llegando ahora": foto, membresía, clase, hora y
 *  check-in rápido (1 toque). Tocar el cuerpo abre el modal con todas las acciones. */
function LlegandoCard({ reserva, tz, mostrarSala, onSelect, onQuickCheckIn }: {
  reserva: ReservaConJoin; tz: string; mostrarSala: boolean; onSelect: (r: ReservaConJoin) => void; onQuickCheckIn: (r: ReservaConJoin) => Promise<void>;
}) {
  const hora = formatHoraEnTz(new Date(reserva.slot_inicio), tz);
  const nombre = capitalizarNombre(reserva.usuario?.nombre) || reserva.usuario?.email || '—';
  const tier = reserva.usuario?.membresia_tier;
  const lugar = (reserva as { lugar_id?: string | null }).lugar_id;
  const ya = reserva.status === 'completada';
  const [busy, setBusy] = useState(false);

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: '14px',
        padding: '14px 16px', borderRadius: '18px',
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--ek-mustard) 9%, var(--sala-surface)), var(--sala-surface))',
        border: '1px solid color-mix(in srgb, var(--ek-mustard) 30%, var(--sala-border))',
        boxShadow: '0 10px 28px rgba(10, 15, 12, 0.08)'
      }}
    >
      <button
        onClick={() => onSelect(reserva)}
        style={{ display: 'flex', alignItems: 'center', gap: '14px', flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
      >
        <Avatar url={reserva.usuario?.avatar_url} nombre={nombre} size={48} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
            <span style={{ fontFamily: 'var(--ek-font-display)', fontSize: '17px', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {nombre}
            </span>
            <TierChip tier={tier} />
            {esCorreoMarcador(reserva.usuario?.email) && (
              <span style={{ flexShrink: 0, fontSize: '10.5px', fontWeight: 700, color: 'var(--ek-warning, #d97706)', background: 'var(--ek-warning-soft, rgba(217,119,6,.14))', borderRadius: '999px', padding: '2px 8px', whiteSpace: 'nowrap' }}>
                Sin correo
              </span>
            )}
          </div>
          <p style={{ fontSize: '12.5px', color: 'var(--sala-text-secondary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {mostrarSala && <>{reserva.recurso?.nombre ?? '—'} · </>}{hora}
            {esCorreoMarcador(reserva.usuario?.email) && <strong style={{ color: 'var(--ek-warning, #d97706)' }}> · pídele su email</strong>}
            {lugar && <strong style={{ color: 'var(--sala-primary)' }}> · Lugar {lugar.replace(/^L/i, '')}</strong>}
          </p>
        </div>
      </button>

      {ya ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', flexShrink: 0, fontSize: '12px', fontWeight: 700, color: 'var(--ek-success)', background: 'var(--ek-success-soft)', borderRadius: '999px', padding: '7px 12px' }}>
          <Check size={14} strokeWidth={2.75} /> Hecho
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={async (e) => { e.stopPropagation(); setBusy(true); await onQuickCheckIn(reserva); setBusy(false); }}
          className="ek-lift"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0,
            fontSize: '13px', fontWeight: 700, fontFamily: 'inherit',
            color: 'var(--ek-bg)', background: 'var(--ek-mustard)',
            border: 'none', borderRadius: '999px', padding: '9px 15px',
            cursor: busy ? 'wait' : 'pointer', boxShadow: '0 4px 12px color-mix(in srgb, var(--ek-mustard) 38%, transparent)'
          }}
        >
          <Check size={15} strokeWidth={2.75} /> {busy ? 'Marcando…' : 'Check-in'}
        </button>
      )}
    </div>
  );
}

function ReservaCard({ reserva, tz, mostrarSala, onSelect }: { reserva: ReservaConJoin; tz: string; mostrarSala: boolean; onSelect: (r: ReservaConJoin) => void }) {
  const hora = formatHoraEnTz(new Date(reserva.slot_inicio), tz);
  const nombre = capitalizarNombre(reserva.usuario?.nombre) || reserva.usuario?.email || '—';
  const tier = reserva.usuario?.membresia_tier;
  // lugar_id viene del `*` pero aún no está en los tipos generados → cast.
  const lugar = (reserva as { lugar_id?: string | null }).lugar_id;
  const disabled = reserva.status === 'cancelada' || reserva.status === 'no_show';

  const statusConfig: Record<string, { label: string; bg: string; color: string }> = {
    confirmada: { label: 'PENDIENTE', bg: 'color-mix(in srgb, var(--ek-mustard) 16%, transparent)', color: 'color-mix(in srgb, var(--ek-mustard), black 18%)' },
    completada: { label: 'OK', bg: 'var(--ek-success-soft)', color: 'var(--ek-success)' },
    cancelada: { label: 'CANCELADA', bg: 'var(--ek-danger-soft)', color: 'var(--ek-danger)' },
    no_show: { label: 'NO SHOW', bg: 'var(--ek-danger-soft)', color: 'var(--ek-danger)' }
  };
  const status = statusConfig[reserva.status] ?? statusConfig.confirmada;

  return (
    <button
      onClick={() => onSelect(reserva)}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px',
        padding: '12px 16px', borderRadius: '14px',
        background: 'var(--sala-surface)', border: '1px solid var(--sala-border)',
        textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
        font: 'inherit', color: 'inherit', width: '100%',
        opacity: disabled ? 0.5 : 1, transition: 'border-color .14s ease'
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.borderColor = 'var(--sala-primary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--sala-border)'; }}
    >
      <span style={{ fontFamily: 'var(--ek-font-display)', fontSize: '17px', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--sala-text-primary)', width: '50px', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
        {hora}
      </span>
      <Avatar url={reserva.usuario?.avatar_url} nombre={nombre} size={38} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '-0.01em', margin: 0, marginBottom: '2px', color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nombre}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {mostrarSala && (reserva.recurso?.nombre ?? '—')}{tier && (mostrarSala ? ` · ${tier}` : tier)}
          {lugar && <strong style={{ color: 'var(--sala-primary)' }}> · Lugar {lugar.replace(/^L/i, '')}</strong>}
        </p>
      </div>
      <span style={{ flexShrink: 0, fontSize: '10px', fontWeight: 800, letterSpacing: '0.06em', borderRadius: '999px', padding: '4px 10px', background: status.bg, color: status.color }}>
        {status.label}
      </span>
    </button>
  );
}

function ManualCheckInModal({
  reserva,
  tz,
  onClose,
  onDone,
  onAccion
}: {
  reserva: ReservaConJoin;
  tz: string;
  onClose: () => void;
  onDone: (data: any) => Promise<void>;
  onAccion: (tipo: AccionReserva) => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cobrandoMulta, setCobrandoMulta] = useState(false);
  const [metodoMulta, setMetodoMulta] = useState<'efectivo' | 'tarjeta' | 'transferencia'>('efectivo');

  const yaCheckIn = reserva.status === 'completada';
  const multaCentavos = (reserva as { multa_centavos?: number }).multa_centavos ?? 0;
  const multaPagada = (reserva as { multa_pagada?: boolean }).multa_pagada ?? false;

  async function cobrarMulta() {
    setCobrandoMulta(true);
    setError(null);
    try {
      const result = await cobrarMultaReserva(reserva.id, metodoMulta);
      await onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cobrar la multa');
      setCobrandoMulta(false);
    }
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await checkInManual(reserva.id, motivo.trim() || undefined);
      playCheckInSuccess();
      await onDone(result);
    } catch (e) {
      playCheckInError();
      setError(e instanceof Error ? e.message : 'Error en check-in');
      setSubmitting(false);
    }
  }

  const hora = formatHoraEnTz(new Date(reserva.slot_inicio), tz);

  const nombreFormat =
    capitalizarNombre(reserva.usuario?.nombre) || reserva.usuario?.email || '—';
  // Si la reserva tiene lugar, la sala usa Mapa de Salón → ofrecemos verlo/editarlo.
  const tieneMapa = !!(reserva as { lugar_id?: string | null }).lugar_id;

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

        {multaCentavos > 0 && !multaPagada && (
          <div
            style={{
              marginTop: '0.85rem',
              padding: '12px 14px',
              borderRadius: '12px',
              background: 'var(--sala-primary-light)',
              border: '1px solid var(--sala-border)'
            }}
          >
            <p style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: 'var(--ek-ink)' }}>
              Multa pendiente · {formatearMoneda(multaCentavos)}
            </p>
            <p style={{ margin: '4px 0 10px', fontSize: '12px', color: 'var(--ek-ink-muted)', lineHeight: 1.4 }}>
              Reservó otra clase tras faltar hoy. Cóbrala aquí.
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <select
                value={metodoMulta}
                onChange={(e) =>
                  setMetodoMulta(e.target.value as 'efectivo' | 'tarjeta' | 'transferencia')
                }
                className="ek-input"
                style={{ flex: 1, fontSize: '13px' }}
                disabled={cobrandoMulta}
              >
                <option value="efectivo">Efectivo</option>
                <option value="tarjeta">Tarjeta</option>
                <option value="transferencia">Transferencia</option>
              </select>
              <button
                type="button"
                onClick={cobrarMulta}
                disabled={cobrandoMulta}
                className="ek-cta"
                style={{ flex: 1, fontSize: '13px' }}
              >
                {cobrandoMulta ? 'Cobrando…' : `Cobrar ${formatearMoneda(multaCentavos)}`}
              </button>
            </div>
          </div>
        )}

        {multaCentavos > 0 && multaPagada && (
          <p
            style={{
              marginTop: '0.6rem',
              fontSize: '12px',
              color: 'var(--ek-success)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <Check size={13} strokeWidth={2.5} /> Multa de {formatearMoneda(multaCentavos)} cobrada
          </p>
        )}

        {tieneMapa && (
          <button
            type="button"
            onClick={() => onAccion('mapa')}
            className="ek-cta ek-cta--secondary"
            style={{ width: '100%', marginTop: '0.85rem', fontSize: '13px' }}
          >
            🗺️ Mapa de la clase · cambiar lugar
          </button>
        )}

        {yaCheckIn ? (
          <>
            <p style={{ color: 'var(--ek-success)', marginTop: '1rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <Check size={15} strokeWidth={2.5} />
              Ya hizo check-in
              {(() => {
                const m = (reserva as { check_in_method?: string }).check_in_method;
                return m ? ` (${m})` : null;
              })()}
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button onClick={onClose} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
                Cerrar
              </button>
              <button onClick={() => onAccion('corregir')} className="ek-cta" style={{ flex: 1 }}>
                Corregir check-in
              </button>
            </div>
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
                Cerrar
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

            {/* Ya quedó como no_show o cancelada pero el socio SÍ fue (no le hicieron
                el check-in): corregir a presente. */}
            {(reserva.status === 'no_show' ||
              reserva.status === 'cancelada' ||
              reserva.status === 'cancelada_admin') && (
              <button
                type="button"
                onClick={() => onAccion('marcar_asistio')}
                disabled={submitting}
                className="ek-cta"
                style={{ width: '100%', marginTop: '0.5rem', fontSize: '13px' }}
              >
                ✓ Sí asistió (corregir)
              </button>
            )}

            {/* No-show / cancelar: solo tiene sentido sobre una reserva confirmada. */}
            {reserva.status === 'confirmada' && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => onAccion('no_show')}
                  disabled={submitting}
                  className="ek-cta ek-cta--secondary"
                  style={{ flex: 1, fontSize: '13px' }}
                >
                  Marcar no-show
                </button>
                <button
                  type="button"
                  onClick={() => onAccion('cancelar')}
                  disabled={submitting}
                  className="ek-cta ek-cta--secondary"
                  style={{ flex: 1, fontSize: '13px', color: 'var(--ek-danger)' }}
                >
                  Cancelar reserva
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
