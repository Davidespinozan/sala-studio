import { useMemo } from 'react';
import { CalendarDays } from 'lucide-react';
import { EmptyState } from '@shared/components/EmptyState';
import { Avatar } from '@shared/components/Avatar';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone, hoyEnTimezone, fechaEnTz, formatHoraEnTz, diasEntre } from '@shared/lib/timezone';
import { useReservasSemana, type ReservaConJoin } from '../hooks/useReservasHoy';

const STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  confirmada: { label: 'Confirmada', color: 'var(--sala-primary)', bg: 'var(--sala-primary-light)' },
  completada: { label: 'Asistió', color: 'var(--sala-success)', bg: 'var(--sala-success-bg)' },
  no_show: { label: 'No-show', color: 'var(--sala-accent)', bg: 'var(--sala-accent-light)' },
  cancelada: { label: 'Cancelada', color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' }
};

// Todo se agrupa y muestra en la zona del GYM: si el dueño mira desde otra zona,
// los días y horas siguen siendo los del gym (no los del navegador).
function claveDia(iso: string, tz: string): string {
  return fechaEnTz(new Date(iso), tz);
}

function etiquetaDia(diaISO: string, hoyISO: string): string {
  const difDias = diasEntre(hoyISO, diaISO);
  if (difDias === 0) return 'Hoy';
  if (difDias === 1) return 'Mañana';
  const [y, m, d] = diaISO.split('-').map(Number);
  const txt = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC'
  });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function hora(iso: string, tz: string): string {
  return formatHoraEnTz(new Date(iso), tz);
}

/** Una clase (recurso + horario) con sus reservas = su lista de asistentes. */
interface ClaseGrupo {
  key: string;
  recursoNombre: string;
  hora: string;
  slotISO: string;
  reservas: ReservaConJoin[];
}
interface Dia {
  key: string;
  label: string;
  clases: ClaseGrupo[];
}

export default function Agenda() {
  const tz = getTenantTimezone(useTenant());
  const { reservas, isLoading } = useReservasSemana(7);

  // Día → clase → reservas. Puro reagrupado de la misma data (sin queries extra).
  const dias = useMemo<Dia[]>(() => {
    const hoyISO = hoyEnTimezone(tz);
    const map = new Map<string, Dia>();
    for (const r of reservas) {
      const dayKey = claveDia(r.slot_inicio, tz);
      if (!map.has(dayKey)) map.set(dayKey, { key: dayKey, label: etiquetaDia(dayKey, hoyISO), clases: [] });
      const dia = map.get(dayKey)!;
      const claseKey = `${r.recurso?.id ?? '·'}-${r.slot_inicio}`;
      let clase = dia.clases.find((c) => c.key === claseKey);
      if (!clase) {
        clase = { key: claseKey, recursoNombre: r.recurso?.nombre ?? 'Clase', hora: hora(r.slot_inicio, tz), slotISO: r.slot_inicio, reservas: [] };
        dia.clases.push(clase);
      }
      clase.reservas.push(r);
    }
    // Ordenar las clases de cada día por hora.
    for (const dia of map.values()) {
      dia.clases.sort((a, b) => a.slotISO.localeCompare(b.slotISO));
    }
    return Array.from(map.values());
  }, [reservas, tz]);

  return (
    <div className="ek-page">
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '16px 20px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '6px' }}>RECEPCIÓN</p>
        <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '28px', fontWeight: 700, letterSpacing: '-0.03em', margin: '0 0 4px', color: 'var(--sala-text-primary)' }}>
          Agenda
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: '0 0 20px' }}>
          Las clases de los próximos 7 días con su lista de asistentes.
        </p>

        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '64px', borderRadius: '14px' }} />
            ))}
          </div>
        ) : dias.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="Sin reservas esta semana"
            subtitle="Cuando los socios reserven, van a aparecer acá por clase."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {dias.map((dia) => (
              <section key={dia.key}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <h2 style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sala-text-primary)', margin: 0 }}>
                    {dia.label}
                  </h2>
                  <span style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
                    {dia.clases.length} {dia.clases.length === 1 ? 'clase' : 'clases'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {dia.clases.map((clase) => (
                    <ClaseCard key={clase.key} clase={clase} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ClaseCard({ clase }: { clase: ClaseGrupo }) {
  const activos = clase.reservas.filter((r) => r.status !== 'cancelada');
  return (
    <div style={{ borderRadius: '16px', background: 'var(--sala-surface)', border: '1px solid var(--sala-border)', overflow: 'hidden' }}>
      {/* Encabezado de la clase */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderBottom: '1px solid var(--sala-border)', background: 'var(--sala-bg)' }}>
        <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--sala-text-primary)', fontVariantNumeric: 'tabular-nums', minWidth: '52px' }}>
          {clase.hora}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 700, color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {clase.recursoNombre}
        </span>
        <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--sala-text-secondary)', background: 'var(--sala-primary-light)', padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap' }}>
          {activos.length} {activos.length === 1 ? 'inscrito' : 'inscritos'}
        </span>
      </div>
      {/* Lista de asistentes */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {clase.reservas.map((r) => (
          <FilaAsistente key={r.id} r={r} />
        ))}
      </div>
    </div>
  );
}

function FilaAsistente({ r }: { r: ReservaConJoin }) {
  const cfg = STATUS_CFG[r.status] ?? { label: r.status, color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' };
  const nombre = r.usuario?.nombre ?? r.usuario?.email ?? 'Socio';
  const invitados = (r as { invitados_count?: number }).invitados_count ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderTop: '1px solid var(--sala-border)' }}>
      <Avatar src={r.usuario?.avatar_url} nombre={nombre} email={r.usuario?.email} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nombre}{invitados > 0 ? ` +${invitados}` : ''}
        </p>
      </div>
      <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: cfg.color, background: cfg.bg, padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap' }}>
        {cfg.label}
      </span>
    </div>
  );
}