import type { Clase } from '@member/logic/claseAdapter';

interface Props {
  clase: Clase;
  /** Cuántos miembros ya están esperando: el usuario quedaría #(total + 1). */
  totalEnEspera: number;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Modal de confirmación para anotarse en la lista de espera de una clase llena. */
export function ConfirmarListaEsperaModal({
  clase,
  totalEnEspera,
  submitting,
  onConfirm,
  onClose
}: Props) {
  const hora = clase.horaLabel;
  const fecha = clase.fechaLabel;
  const posicionFutura = totalEnEspera + 1;

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
          Lista de espera
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
          ¿Anotarte en la lista de espera de {clase.nombre}?
        </h3>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
            marginBottom: '16px',
            lineHeight: 1.5,
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {fecha.charAt(0).toUpperCase() + fecha.slice(1)} · {hora}
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
            Quedarías en la <strong>posición #{posicionFutura}</strong>. Si alguien
            cancela, se libera tu lugar automáticamente y te confirmamos la reserva.
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
              background: 'var(--sala-primary)',
              color: 'var(--sala-text-on-primary)',
              border: '1px solid var(--sala-primary)',
              fontFamily: 'inherit',
              fontSize: '14px',
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1
            }}
          >
            {submitting ? 'Anotando…' : 'Sí, anotarme'}
          </button>
        </div>
      </div>
    </div>
  );
}
