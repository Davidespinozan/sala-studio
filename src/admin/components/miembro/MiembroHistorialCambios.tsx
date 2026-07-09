import { useMiembroAuditoria } from '../../hooks/useMiembroAuditoria';

/**
 * "Historial de cambios" de un socio: acciones de recepción/admin que quedaron
 * registradas en auditoria_recepcion (renovar, cambiar plan, recargar créditos,
 * bloquear, cancelar, notas, check-in…). Trazabilidad de quién hizo qué y cuándo.
 * Solo admin lo ve (RLS de la tabla).
 */

const ENTIDAD_CFG: Record<string, { label: string; color: string; bg: string }> = {
  membresia: { label: 'Membresía', color: 'var(--sala-primary)', bg: 'var(--sala-primary-light)' },
  socio: { label: 'Socio', color: 'var(--sala-accent)', bg: 'var(--sala-accent-light)' },
  reserva: { label: 'Reserva', color: 'var(--sala-accent)', bg: 'var(--sala-accent-light)' },
  checkin: { label: 'Check-in', color: 'var(--sala-success)', bg: 'var(--sala-success-bg)' },
  clase: { label: 'Clase', color: 'var(--sala-text-secondary)', bg: 'var(--sala-bg)' },
  pago: { label: 'Pago', color: 'var(--sala-text-secondary)', bg: 'var(--sala-bg)' }
};

function formatFechaHora(iso: string): string {
  const txt = new Date(iso).toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

export function MiembroHistorialCambios({ usuarioId }: { usuarioId: string | undefined }) {
  const { entries, isLoading, error } = useMiembroAuditoria(usuarioId);

  if (isLoading) {
    return <div className="ek-skeleton" style={{ height: '76px', borderRadius: '14px' }} />;
  }

  if (error) {
    return (
      <p style={{ fontSize: '13px', color: 'var(--sala-error)', margin: 0 }}>{error}</p>
    );
  }

  if (entries.length === 0) {
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
          Sin cambios registrados todavía.
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
      {entries.map((e, idx) => {
        const ent = e.entidad ?? e.accion.split('.')[0];
        const cfg = ENTIDAD_CFG[ent] ?? { label: ent, color: 'var(--sala-text-secondary)', bg: 'var(--sala-bg)' };
        return (
          <div
            key={e.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: '12px',
              alignItems: 'start',
              padding: '12px 16px',
              borderBottom: idx < entries.length - 1 ? '1px solid var(--sala-border)' : 'none'
            }}
          >
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: '13px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.4 }}>
                {e.resumen}
              </p>
              <p style={{ fontSize: '12px', color: 'var(--sala-text-secondary)', margin: '3px 0 0' }}>
                {formatFechaHora(e.creado_en)} · {e.actor_nombre}
                {e.actor_rol === 'recepcionista' ? ' (recepción)' : ''}
              </p>
            </div>
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
