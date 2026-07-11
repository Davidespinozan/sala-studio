import { useMemo } from 'react';
import { CalendarDays } from 'lucide-react';
import { EmptyState } from '@shared/components/EmptyState';
import { Avatar } from '@shared/components/Avatar';
import { useReservasSemana, type ReservaConJoin } from '../hooks/useReservasHoy';

const STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  confirmada: { label: 'Confirmada', color: 'var(--sala-primary)', bg: 'var(--sala-primary-light)' },
  completada: { label: 'Asistió', color: 'var(--sala-success)', bg: 'var(--sala-success-bg)' },
  no_show: { label: 'No-show', color: 'var(--sala-accent)', bg: 'var(--sala-accent-light)' },
  cancelada: { label: 'Cancelada', color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' }
};

function claveDia(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function etiquetaDia(iso: string): string {
  const d = new Date(iso);
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const diaMs = new Date(d).setHours(0, 0, 0, 0);
  const difDias = Math.round((diaMs - hoy.getTime()) / 86400000);
  if (difDias === 0) return 'Hoy';
  if (difDias === 1) return 'Mañana';
  const txt = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

interface Dia {
  key: string;
  label: string;
  reservas: ReservaConJoin[];
}

export default function Agenda() {
  const { reservas, isLoading } = useReservasSemana(7);

  const dias = useMemo<Dia[]>(() => {
    const map = new Map<string, Dia>();
    for (const r of reservas) {
      const key = claveDia(r.slot_inicio);
      if (!map.has(key)) map.set(key, { key, label: etiquetaDia(r.slot_inicio), reservas: [] });
      map.get(key)!.reservas.push(r);
    }
    return Array.from(map.values());
  }, [reservas]);

  return (
    <div className="ek-page">
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '16px 20px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '6px' }}>RECEPCIÓN</p>
        <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '28px', fontWeight: 700, letterSpacing: '-0.03em', margin: '0 0 4px', color: 'var(--sala-text-primary)' }}>
          Agenda
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: '0 0 20px' }}>
          Las reservas de los próximos 7 días.
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
            subtitle="Cuando los socios reserven, van a aparecer acá por día."
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
                    {dia.reservas.length} {dia.reservas.length === 1 ? 'reserva' : 'reservas'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {dia.reservas.map((r) => (
                    <FilaReserva key={r.id} r={r} />
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

function FilaReserva({ r }: { r: ReservaConJoin }) {
  const cfg = STATUS_CFG[r.status] ?? { label: r.status, color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' };
  const nombre = r.usuario?.nombre ?? r.usuario?.email ?? 'Socio';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '12px 14px',
        borderRadius: '14px',
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)'
      }}
    >
      <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--sala-text-primary)', fontVariantNumeric: 'tabular-nums', minWidth: '48px' }}>
        {hora(r.slot_inicio)}
      </span>
      <Avatar src={r.usuario?.avatar_url} nombre={nombre} email={r.usuario?.email} size={34} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nombre}
        </p>
        <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.recurso?.nombre ?? 'Clase'}
        </p>
      </div>
      <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: cfg.color, background: cfg.bg, padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap' }}>
        {cfg.label}
      </span>
    </div>
  );
}
