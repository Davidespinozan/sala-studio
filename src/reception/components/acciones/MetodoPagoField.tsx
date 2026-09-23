import { useEffect, useState } from 'react';

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
  /**
   * Reporta si la selección está LISTA para confirmar. "Sin registrar cobro" (value '')
   * NO está listo hasta que el operador confirma que el socio ya pagó en línea — así se
   * evita activar/renovar un plan gratis y en silencio (sin ingreso ni "por cobrar").
   * El padre debe incluir este valor en su canConfirm.
   */
  onListoChange?: (listo: boolean) => void;
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
  moneda = 'MXN',
  onListoChange
}: Props) {
  const total = precioCentavos + inscripcionCentavos;

  // "Sin registrar cobro" exige confirmar que el socio ya pagó en línea.
  const [yaPagoOnline, setYaPagoOnline] = useState(false);
  // Al elegir un método real, la confirmación deja de aplicar (y se limpia).
  useEffect(() => {
    if (value !== '') setYaPagoOnline(false);
  }, [value]);
  const listo = value !== '' || yaPagoOnline;
  useEffect(() => {
    onListoChange?.(listo);
  }, [listo, onListoChange]);

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
        <div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={yaPagoOnline}
              onChange={(e) => setYaPagoOnline(e.target.checked)}
            />
            El socio ya pagó en línea (activar sin registrar cobro)
          </label>
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px', lineHeight: 1.45 }}>
            Sin registrar cobro no queda ni ingreso ni “por cobrar”. Si aún no paga, elige un
            método arriba (o usa “Cortesía” para regalarlo con registro).
          </p>
        </div>
      )}
    </div>
  );
}
