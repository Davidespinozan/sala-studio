import { formatHora } from '@member/logic/reservaLogic';

export interface HistorialItem {
  id: string;
  slot_inicio: string;
  recurso_nombre: string;
  status: 'completada' | 'no_show' | 'cancelada' | 'cancelada_admin';
}

interface Props {
  items: HistorialItem[];
}

const STATUS_CFG: Record<HistorialItem['status'], { label: string; color: string; bg: string }> = {
  completada: {
    label: 'Asistió',
    color: 'var(--sala-success)',
    bg: 'var(--sala-success-bg)'
  },
  no_show: {
    label: 'No-show',
    color: 'var(--sala-accent)',
    bg: 'var(--sala-accent-light)'
  },
  cancelada: {
    label: 'Cancelada',
    color: 'var(--sala-text-tertiary)',
    bg: 'var(--sala-bg)'
  },
  cancelada_admin: {
    label: 'Cancelada (admin)',
    color: 'var(--sala-text-tertiary)',
    bg: 'var(--sala-bg)'
  }
};

function formatFecha(iso: string): string {
  const d = new Date(iso);
  const txt = d.toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
  return txt.charAt(0).toUpperCase() + txt.slice(1).replace(/\.$/, '');
}

export function MiembroHistorial({ items }: Props) {
  if (items.length === 0) {
    return (
      <div
        style={{
          padding: '24px',
          textAlign: 'center',
          background: 'var(--sala-surface)',
          border: '1px dashed var(--sala-border-strong)',
          borderRadius: '14px'
        }}
      >
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0 }}>
          Aún no asistió a clases.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '14px',
        overflow: 'hidden',
        maxHeight: '400px',
        overflowY: 'auto'
      }}
    >
      {items.map((r, idx) => {
        const cfg = STATUS_CFG[r.status];
        return (
          <div
            key={r.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '100px 1fr auto',
              gap: '12px',
              alignItems: 'center',
              padding: '12px 16px',
              borderBottom: idx < items.length - 1 ? '1px solid var(--sala-border)' : 'none'
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: 'var(--sala-text-primary)'
                }}
              >
                {formatFecha(r.slot_inicio)}
              </span>
              <span
                style={{
                  fontSize: '12px',
                  color: 'var(--sala-text-secondary)',
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {formatHora(new Date(r.slot_inicio))}
              </span>
            </div>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--sala-text-primary)',
                margin: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {r.recurso_nombre}
            </p>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: cfg.color,
                background: cfg.bg,
                padding: '4px 10px',
                borderRadius: '999px',
                whiteSpace: 'nowrap'
              }}
            >
              {cfg.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
