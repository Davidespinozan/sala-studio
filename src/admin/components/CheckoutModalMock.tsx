import { useState } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { crearSuscripcion } from '../lib/suscripcionService';
import {
  PLANES_SAAS,
  TRIAL_DIAS,
  formatPrecio,
  precioCentavos,
  type TierSaas,
  type MonedaSaas
} from '@shared/lib/planesSaas';

interface Props {
  tier: TierSaas;
  moneda: MonedaSaas;
  onClose: () => void;
  onConfirmed: () => void;
}

/**
 * Checkout SIMULADO. No procesa ningún pago: al confirmar llama a
 * crearSuscripcion() (mock). Ver src/admin/lib/suscripcionService.ts.
 */
export function CheckoutModalMock({ tier, moneda, onClose, onConfirmed }: Props) {
  const tenant = useTenant();
  const toast = useToast();
  const [procesando, setProcesando] = useState(false);

  const plan = PLANES_SAAS[tier];
  const precioStr = `${formatPrecio(precioCentavos(tier, moneda), moneda)}/mes`;

  async function handleConfirmar() {
    setProcesando(true);
    const { error } = await crearSuscripcion({ tenantId: tenant.id, tier, moneda });
    setProcesando(false);
    if (error) {
      toast.error('No pudimos activar la suscripción. Prueba de nuevo.');
      return;
    }
    toast.success('¡Suscripción activada! (modo demo)');
    onConfirmed();
  }

  return (
    <div className="adm-modal-backdrop" onClick={() => !procesando && onClose()}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            marginBottom: '4px'
          }}
        >
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>
            CHECKOUT
          </p>
          <span
            style={{
              fontSize: '9px',
              fontWeight: 700,
              letterSpacing: '0.12em',
              color: 'var(--sala-accent)',
              background: 'var(--sala-accent-light)',
              padding: '3px 8px',
              borderRadius: '999px'
            }}
          >
            MODO DEMO
          </span>
        </div>
        <h3 className="ek-h3" style={{ marginBottom: '12px' }}>
          Suscribirte a {plan.nombre}
        </h3>

        {/* Resumen del cargo */}
        <div
          style={{
            background: 'var(--sala-primary-light)',
            border: '1px solid var(--sala-border)',
            borderRadius: '12px',
            padding: '14px 16px',
            marginBottom: '18px'
          }}
        >
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '22px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--sala-text-primary)',
              margin: '0 0 4px'
            }}
          >
            {precioStr} <span style={{ fontSize: '13px', fontWeight: 500 }}>{moneda.toUpperCase()}</span>
          </p>
          <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, lineHeight: 1.5 }}>
            {TRIAL_DIAS} días de prueba gratis. Después, {precioStr}. Cancelas cuando quieras.
          </p>
        </div>

        {/* Datos de pago — visuales, no funcionales */}
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--sala-text-tertiary)',
            margin: '0 0 8px'
          }}
        >
          Datos de pago (modo demo)
        </p>
        <input
          className="ek-input"
          value="4242 4242 4242 4242"
          disabled
          readOnly
          aria-label="Número de tarjeta (demo)"
        />
        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
          <input
            className="ek-input"
            value="12 / 30"
            disabled
            readOnly
            aria-label="Vencimiento (demo)"
            style={{ flex: 1 }}
          />
          <input
            className="ek-input"
            value="···"
            disabled
            readOnly
            aria-label="CVC (demo)"
            style={{ flex: 1 }}
          />
        </div>
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', margin: '8px 0 0' }}>
          Esto es una demostración. No se procesa ni se cobra ningún pago real.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
          <button
            onClick={onClose}
            disabled={procesando}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirmar}
            disabled={procesando}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {procesando ? 'Activando…' : 'Confirmar suscripción (DEMO)'}
          </button>
        </div>
      </div>
    </div>
  );
}
