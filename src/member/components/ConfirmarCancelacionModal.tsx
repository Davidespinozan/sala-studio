import type { Clase } from '@member/logic/claseAdapter';

interface Props {
  clase: Clase;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Modal de confirmación destructiva para cancelar una reserva existente. */
export function ConfirmarCancelacionModal({ clase, submitting, onConfirm, onClose }: Props) {
  // S4.4: labels precomputadas en la timezone del gym.
  const hora = clase.horaLabel;
  const fecha = clase.fechaLabel;

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ek-modal-handle" />
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--sala-error)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Cancelar reserva
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '8px',
            color: 'var(--sala-text-primary)'
          }}
        >
          ¿Cancelar tu lugar en {clase.nombre}?
        </h3>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
            marginBottom: '20px',
            lineHeight: 1.5,
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {fecha.charAt(0).toUpperCase() + fecha.slice(1)} · {hora}<br />
          Si cancelás con anticipación, no hay penalidad.
        </p>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Volver
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            style={{
              flex: 1,
              padding: '12px 22px',
              minHeight: '44px',
              borderRadius: '14px',
              background: 'transparent',
              color: 'var(--sala-accent)',
              border: '1px solid var(--sala-accent)',
              fontFamily: 'inherit',
              fontSize: '14px',
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1
            }}
          >
            {submitting ? 'Cancelando…' : 'Sí, cancelar'}
          </button>
        </div>
      </div>
    </div>
  );
}
