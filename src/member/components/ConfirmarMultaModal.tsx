import { formatearMoneda } from '@shared/lib/dinero';

interface Props {
  /** Monto de la multa en centavos (lo que estampa el trigger del tope diario). */
  centavos: number;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Modal del Modelo A: el socio faltó a su clase de hoy y quiere reservar otra.
 * Se le permite, pero asumiendo una multa que se cobra en recepción cuando llega.
 * Si no confirma, no se cobra nada.
 */
export function ConfirmarMultaModal({ centavos, submitting, onConfirm, onClose }: Props) {
  const monto = formatearMoneda(centavos);
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
            color: 'var(--sala-primary)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Reserva con multa
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
          ¿Reservar asumiendo una multa de {monto}?
        </h3>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
            marginBottom: '16px',
            lineHeight: 1.5
          }}
        >
          Faltaste a tu clase de hoy sin cancelarla. Ya usaste tu reserva del día, pero
          puedes tomar otra pagando una multa.
        </p>

        <div
          style={{
            background: 'var(--sala-primary-light)',
            border: '1px solid var(--sala-border)',
            borderRadius: '12px',
            padding: '14px 16px',
            marginBottom: '20px'
          }}
        >
          <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
            La multa de <strong>{monto}</strong> se cobra en recepción cuando llegues.
            Si no reservas, no se cobra nada.
          </p>
        </div>

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
              background: 'var(--sala-accent)',
              color: 'var(--sala-text-on-accent)',
              border: '1px solid var(--sala-accent)',
              fontFamily: 'inherit',
              fontSize: '14px',
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1
            }}
          >
            {submitting ? 'Reservando…' : `Sí, reservar (${monto})`}
          </button>
        </div>
      </div>
    </div>
  );
}