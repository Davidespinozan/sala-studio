import { useNotificacionesMiembro } from '@shared/hooks/useNotificacionesMiembro';

/**
 * Banner sticky de notificaciones in-app para miembros. Sprint Final.
 * Render condicional: solo si hay notificaciones no leídas.
 * Cada notificación se cierra individualmente con su botón ✕.
 */
export default function NotificacionesBanner() {
  const { notificaciones, marcarLeida } = useNotificacionesMiembro();

  if (notificaciones.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Notificaciones"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5px',
        position: 'sticky',
        top: 0,
        zIndex: 70
      }}
    >
      {notificaciones.map((n) => (
        <div
          key={n.id}
          style={{
            background: 'var(--ek-mustard-soft)',
            borderBottom: '0.5px solid var(--ek-mustard-dim)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '12px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', minWidth: 0 }}>
            <span aria-hidden="true" style={{ fontSize: '16px', lineHeight: 1.4 }}>
              ⚠️
            </span>
            <div style={{ minWidth: 0 }}>
              <p
                style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '14px',
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  margin: 0,
                  marginBottom: '2px',
                  color: 'var(--ek-mustard)'
                }}
              >
                {n.titulo}
              </p>
              <p
                style={{
                  fontSize: '13px',
                  color: 'var(--ek-ink)',
                  margin: 0,
                  lineHeight: 1.5
                }}
              >
                {n.mensaje}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => marcarLeida(n.id)}
            aria-label="Marcar como leída"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--ek-mustard)',
              cursor: 'pointer',
              fontSize: '16px',
              padding: '0 4px',
              lineHeight: 1
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
