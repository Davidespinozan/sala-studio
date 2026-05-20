import type { Clase } from '@member/logic/claseAdapter';

interface Props {
  clase: Clase;
  maxInvitados: number;
  invitados: number;
  onInvitadosChange: (n: number) => void;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** Modal sheet (mobile-first) para confirmar la reserva de una clase.
 *  Stepper de invitados según el tier del miembro. */
export function ConfirmarReservaModal({
  clase,
  maxInvitados,
  invitados,
  onInvitadosChange,
  submitting,
  error,
  onConfirm,
  onClose
}: Props) {
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
            color: 'var(--sala-primary)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Confirmar reserva
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '22px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '6px',
            color: 'var(--sala-text-primary)'
          }}
        >
          {clase.nombre}
        </h3>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
            marginBottom: '20px',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {fecha.charAt(0).toUpperCase() + fecha.slice(1)} · {hora} · {clase.duracionMinutos} min<br />
          {clase.instructorNombre ? `con ${clase.instructorNombre}` : 'Instructor por confirmar'}
        </p>

        {maxInvitados > 0 && (
          <div style={{ marginBottom: '18px' }}>
            <label
              style={{
                display: 'block',
                fontSize: '13px',
                color: 'var(--sala-text-secondary)',
                marginBottom: '8px',
                fontWeight: 500
              }}
            >
              Invitados ({invitados} de {maxInvitados} disponibles)
            </label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => onInvitadosChange(Math.max(0, invitados - 1))}
                disabled={invitados === 0}
                className="ek-cta ek-cta--secondary"
                style={{ minHeight: '40px', minWidth: '40px', padding: '0 12px' }}
              >
                −
              </button>
              <span
                style={{
                  fontSize: '20px',
                  fontWeight: 700,
                  minWidth: '40px',
                  textAlign: 'center',
                  color: 'var(--sala-text-primary)',
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {invitados}
              </span>
              <button
                type="button"
                onClick={() => onInvitadosChange(Math.min(maxInvitados, invitados + 1))}
                disabled={invitados === maxInvitados}
                className="ek-cta ek-cta--secondary"
                style={{ minHeight: '40px', minWidth: '40px', padding: '0 12px' }}
              >
                +
              </button>
              <span
                style={{
                  fontSize: '12px',
                  color: 'var(--sala-text-tertiary)',
                  marginLeft: '8px'
                }}
              >
                Total: {1 + invitados} {1 + invitados === 1 ? 'persona' : 'personas'}
              </span>
            </div>
          </div>
        )}

        {error && (
          <p
            style={{
              fontSize: '13px',
              color: 'var(--sala-error)',
              background: 'var(--sala-error-bg)',
              padding: '10px 12px',
              borderRadius: '10px',
              margin: 0,
              marginBottom: '16px'
            }}
          >
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {submitting ? 'Reservando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
}
