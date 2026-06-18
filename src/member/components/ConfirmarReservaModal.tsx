import type { Clase } from '@member/logic/claseAdapter';
import { useLugaresSala } from '@member/hooks/useLugaresSala';
import { SeleccionarLugar } from './SeleccionarLugar';

interface Props {
  clase: Clase;
  maxInvitados: number;
  invitados: number;
  onInvitadosChange: (n: number) => void;
  /** Créditos que cuesta la reserva (1 + invitados) si el plan es por créditos.
   *  null = plan por tiempo (ilimitado) → no se muestra costo. */
  costoCreditos?: number | null;
  /** Saldo de créditos del socio (solo planes por créditos). null = ilimitado. */
  creditosRestantes?: number | null;
  /** Mapa de Salón: lugar elegido. null = ninguno todavía. */
  lugarId: string | null;
  onLugarChange: (id: string) => void;
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
  costoCreditos,
  creditosRestantes,
  lugarId,
  onLugarChange,
  submitting,
  error,
  onConfirm,
  onClose
}: Props) {
  // S4.4: labels precomputadas en la timezone del gym.
  const hora = clase.horaLabel;
  const fecha = clase.fechaLabel;

  // Plan por créditos: ¿alcanza el saldo para esta reserva (socio + invitados)?
  const muestraSaldo = costoCreditos != null && creditosRestantes != null;
  const saldoInsuficiente = muestraSaldo && costoCreditos! > creditosRestantes!;

  // Mapa de Salón: si la sala tiene layout, el socio elige su lugar (sin invitados).
  const { layout, tomados } = useLugaresSala(clase.recursoId, clase.claseId);
  const faltaLugar = !!layout && !lugarId;

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

        {layout && (
          <div style={{ marginBottom: '18px' }}>
            <label
              style={{ display: 'block', fontSize: '13px', color: 'var(--sala-text-secondary)', marginBottom: '8px', fontWeight: 500 }}
            >
              Elige tu lugar
            </label>
            <SeleccionarLugar layout={layout} tomados={tomados} seleccionado={lugarId} onSelect={onLugarChange} />
          </div>
        )}

        {!layout && maxInvitados > 0 && (
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
                {costoCreditos != null && (
                  <> · {costoCreditos} {costoCreditos === 1 ? 'crédito' : 'créditos'}</>
                )}
              </span>
            </div>
          </div>
        )}

        {muestraSaldo && (
          <p
            style={{
              fontSize: '13px',
              margin: 0,
              marginBottom: saldoInsuficiente ? '8px' : '16px',
              color: 'var(--sala-text-secondary)'
            }}
          >
            Te {creditosRestantes === 1 ? 'queda' : 'quedan'}{' '}
            <strong style={{ color: 'var(--sala-text-primary)' }}>
              {creditosRestantes} {creditosRestantes === 1 ? 'crédito' : 'créditos'}
            </strong>
            {!saldoInsuficiente && costoCreditos != null && (
              <> · te {creditosRestantes! - costoCreditos === 1 ? 'quedará' : 'quedarán'} {creditosRestantes! - costoCreditos} tras reservar</>
            )}
          </p>
        )}

        {saldoInsuficiente && (
          <p
            style={{
              fontSize: '13px',
              color: 'var(--sala-warning)',
              background: 'var(--sala-warning-bg)',
              padding: '10px 12px',
              borderRadius: '10px',
              margin: 0,
              marginBottom: '16px'
            }}
          >
            No te alcanzan los créditos para esta reserva. Quitá invitados o recargá tu paquete.
          </p>
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
            disabled={submitting || saldoInsuficiente || faltaLugar}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {submitting ? 'Reservando…' : faltaLugar ? 'Elige un lugar' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
}
