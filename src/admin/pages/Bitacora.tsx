import { useMemo, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { PageHeader } from '@shared/components/PageHeader';
import { EmptyState } from '@shared/components/EmptyState';
import { useBitacora, type BitacoraEntry } from '../hooks/useBitacora';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone } from '@shared/lib/timezone';

// Color del badge según la entidad afectada.
const ENTIDAD_COLOR: Record<string, { bg: string; fg: string }> = {
  membresia: { bg: 'var(--sala-primary-light)', fg: 'var(--sala-primary)' },
  reserva: { bg: 'var(--sala-accent-light, var(--sala-primary-light))', fg: 'var(--sala-accent)' },
  socio: { bg: 'var(--ek-mustard-soft, var(--ek-bg-elevated))', fg: 'var(--ek-mustard)' },
  checkin: { bg: 'var(--ek-success-soft)', fg: 'var(--ek-success)' },
  clase: { bg: 'var(--ek-bg-elevated)', fg: 'var(--sala-text-secondary)' },
  pago: { bg: 'var(--ek-bg-elevated)', fg: 'var(--sala-text-secondary)' },
};

const ENTIDADES = ['todas', 'membresia', 'reserva', 'socio', 'checkin', 'clase', 'pago'] as const;

const normalize = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function fmtFecha(iso: string, tz: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  });
}

function capitalizar(s: string | null): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function Bitacora() {
  const { entries, isLoading, error } = useBitacora();
  const tz = getTenantTimezone(useTenant());
  const [entidad, setEntidad] = useState<string>('todas');
  const [q, setQ] = useState('');

  const filtradas = useMemo(() => {
    const term = normalize(q.trim());
    return entries.filter((e) => {
      if (entidad !== 'todas' && (e.entidad ?? '') !== entidad) return false;
      if (!term) return true;
      return (
        normalize(e.resumen).includes(term) ||
        normalize(e.actor_nombre).includes(term) ||
        normalize(e.socio_nombre ?? '').includes(term)
      );
    });
  }, [entries, entidad, q]);

  return (
    <div style={{ maxWidth: '760px' }}>
      <PageHeader
        eyebrow="AUDITORÍA"
        title="Bitácora de recepción"
        subtitle="Quién hizo qué — membresías, reservas, socios y check-ins."
      />

      {/* Filtros */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '18px', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="ek-input"
          placeholder="Buscar por socio, acción o quién la hizo…"
          style={{ flex: '1 1 240px', minHeight: '44px' }}
        />
        <select
          value={entidad}
          onChange={(e) => setEntidad(e.target.value)}
          className="ek-input"
          style={{ flex: '0 0 auto', minHeight: '44px' }}
        >
          {ENTIDADES.map((ent) => (
            <option key={ent} value={ent}>
              {ent === 'todas' ? 'Todas las acciones' : capitalizar(ent)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div
          style={{
            background: 'var(--ek-danger-soft)',
            border: '1px solid var(--sala-error-glow)',
            color: 'var(--ek-danger)',
            borderRadius: 'var(--ek-r-md)',
            padding: '10px 12px',
            marginBottom: '14px',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      )}

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <div key={n} className="ek-skeleton" style={{ height: '76px', borderRadius: 'var(--ek-r-md)' }} />
          ))}
        </div>
      ) : filtradas.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={entries.length === 0 ? 'Sin movimientos todavía' : 'Sin coincidencias'}
          subtitle={
            entries.length === 0
              ? 'Las acciones de recepción (renovar, cancelar, bloquear, check-in…) van a aparecer acá.'
              : 'Prueba con otra búsqueda o cambia el filtro de acción.'
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {filtradas.map((e) => (
            <EntradaBitacora key={e.id} entry={e} tz={tz} />
          ))}
        </div>
      )}
    </div>
  );
}

function EntradaBitacora({ entry, tz }: { entry: BitacoraEntry; tz: string }) {
  const [verDetalle, setVerDetalle] = useState(false);
  const [ent, verbo] = entry.accion.split('.');
  const color = ENTIDAD_COLOR[entry.entidad ?? ent] ?? { bg: 'var(--ek-bg-elevated)', fg: 'var(--sala-text-secondary)' };
  const tieneDetalle = entry.detalle && Object.keys(entry.detalle).length > 0;

  return (
    <div className="ek-card ek-card--md">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '6px' }}>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            padding: '3px 9px',
            borderRadius: '999px',
            background: color.bg,
            color: color.fg,
            whiteSpace: 'nowrap',
          }}
        >
          {(verbo ?? entry.accion).replace(/_/g, ' ')}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', whiteSpace: 'nowrap' }}>
          {fmtFecha(entry.creado_en, tz)}
        </span>
      </div>

      <p style={{ fontSize: '14px', color: 'var(--ek-ink)', margin: 0, lineHeight: 1.45 }}>{entry.resumen}</p>

      <p style={{ fontSize: '12px', color: 'var(--sala-text-secondary)', margin: '4px 0 0' }}>
        por <strong>{capitalizar(entry.actor_nombre)}</strong> · {entry.actor_rol}
        {entry.socio_nombre ? ` · socio: ${capitalizar(entry.socio_nombre)}` : ''}
      </p>

      {tieneDetalle && (
        <>
          <button
            type="button"
            onClick={() => setVerDetalle((v) => !v)}
            className="ek-cta ek-cta--secondary"
            style={{ marginTop: '10px', fontSize: '11px', padding: '4px 10px' }}
          >
            {verDetalle ? 'Ocultar detalle' : 'Ver detalle'}
          </button>
          {verDetalle && (
            <pre
              style={{
                marginTop: '8px',
                padding: '10px 12px',
                background: 'var(--ek-bg-elevated)',
                borderRadius: 'var(--ek-r-sm)',
                fontSize: '11.5px',
                fontFamily: 'var(--ek-font-mono)',
                color: 'var(--sala-text-secondary)',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(entry.detalle, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
