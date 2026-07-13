function formatearPrecio(centavos: number, moneda: string): string {
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: (moneda || 'MXN').toUpperCase(),
      maximumFractionDigits: 0
    }).format(centavos / 100);
  } catch {
    return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
  }
}

export const METODOS_PAGO = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'tarjeta', label: 'Tarjeta (terminal)' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: 'cortesia', label: 'Cortesía (no se cobra)' }
] as const;

export type MetodoPago = (typeof METODOS_PAGO)[number]['value'];

interface Props {
  value: MetodoPago | '';
  onChange: (m: MetodoPago | '') => void;
  /** Precio de lista del plan elegido, en centavos. */
  precioCentavos: number;
  /** Inscripción a cobrar AHORA (0 si el plan no cobra o el socio ya la pagó). */
  inscripcionCentavos: number;
  moneda?: string;
}

/**
 * Método de pago del mostrador. Lo que se elija acá es lo que queda registrado en
 * la tabla `pagos` (antes un cobro en efectivo no dejaba ningún rastro del monto).
 *
 * 'cortesía' registra el movimiento con monto pero método 'cortesia', para que el
 * corte de caja no lo cuente como dinero recibido.
 */
export function MetodoPagoField({
  value,
  onChange,
  precioCentavos,
  inscripcionCentavos,
  moneda = 'MXN'
}: Props) {
  const total = precioCentavos + inscripcionCentavos;

  return (
    <div
      className="ek-form-field"
      style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}
    >
      <label className="ek-label" htmlFor="metodo-pago">Método de pago</label>
      <select
        id="metodo-pago"
        className="ek-input"
        value={value}
        onChange={(e) => onChange(e.target.value as MetodoPago | '')}
      >
        <option value="">Sin registrar cobro</option>
        {METODOS_PAGO.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>

      {total > 0 && (
        <div
          style={{
            fontSize: '13px',
            color: 'var(--sala-text-secondary)',
            background: 'var(--sala-primary-light)',
            border: '0.5px solid var(--sala-border)',
            borderRadius: '8px',
            padding: '10px 12px',
            lineHeight: 1.6
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Plan</span>
            <span>{formatearPrecio(precioCentavos, moneda)}</span>
          </div>
          {inscripcionCentavos > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Inscripción (única vez)</span>
              <span>{formatearPrecio(inscripcionCentavos, moneda)}</span>
            </div>
          )}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontWeight: 700,
              color: 'var(--sala-text-primary)',
              borderTop: '0.5px solid var(--sala-border)',
              marginTop: '6px',
              paddingTop: '6px'
            }}
          >
            <span>Total a cobrar</span>
            <span>{formatearPrecio(total, moneda)}</span>
          </div>
        </div>
      )}

      {value === '' && (
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
          Sin método no se registra ningún cobro: el plan igual se activa. Usalo solo si el socio
          ya pagó online.
        </p>
      )}
    </div>
  );
}
