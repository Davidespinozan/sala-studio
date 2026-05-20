import { useState } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone } from '@shared/lib/timezone';
import { useSuscripcion } from '../hooks/useSuscripcion';
import { CheckoutModalMock } from '../components/CheckoutModalMock';
import {
  PLANES_SAAS,
  TIERS_ORDEN,
  MONEDAS,
  TRIAL_DIAS,
  formatPrecio,
  precioCentavos,
  monedaSugerida,
  type TierSaas,
  type MonedaSaas
} from '../lib/planesSaas';

export default function Suscripcion() {
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const { suscripcion, isLoading, refetch } = useSuscripcion();

  const [moneda, setMoneda] = useState<MonedaSaas>(() => monedaSugerida(tz));
  const [checkout, setCheckout] = useState<TierSaas | null>(null);

  // El tier vigente — null si no hay suscripción o está cancelada.
  const tierActual =
    suscripcion && suscripcion.estado !== 'cancelada'
      ? (suscripcion.tier as TierSaas)
      : null;

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">SUSCRIPCIÓN</p>
          <h1 className="ek-h2">Tu plan en SALA</h1>
        </div>
        <span
          title="Los pagos están simulados — todavía no se cobra de verdad."
          style={{
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: 'var(--sala-accent)',
            background: 'var(--sala-accent-light)',
            padding: '4px 10px',
            borderRadius: '999px'
          }}
        >
          MODO DEMO
        </span>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <>
          {/* Selector de moneda */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              flexWrap: 'wrap',
              marginBottom: '20px'
            }}
          >
            <span style={{ fontSize: '12px', color: 'var(--sala-text-secondary)', fontWeight: 600 }}>
              Moneda:
            </span>
            {MONEDAS.map((m) => {
              const activa = moneda === m.codigo;
              return (
                <button
                  key={m.codigo}
                  type="button"
                  onClick={() => setMoneda(m.codigo)}
                  style={{
                    padding: '6px 14px',
                    minHeight: '32px',
                    background: activa ? 'var(--sala-primary)' : 'var(--sala-surface)',
                    color: activa ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                    border: `1px solid ${activa ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
                    borderRadius: '999px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit'
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          {/* Cards de planes */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '14px'
            }}
          >
            {TIERS_ORDEN.map((tier) => (
              <PlanCard
                key={tier}
                tier={tier}
                moneda={moneda}
                esActual={tier === tierActual}
                hayPlanActivo={tierActual !== null}
                onElegir={() => setCheckout(tier)}
              />
            ))}
          </div>
        </>
      )}

      {checkout && (
        <CheckoutModalMock
          tier={checkout}
          moneda={moneda}
          onClose={() => setCheckout(null)}
          onConfirmed={async () => {
            await refetch();
            setCheckout(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Card de plan
// ============================================================================

function PlanCard({
  tier,
  moneda,
  esActual,
  hayPlanActivo,
  onElegir
}: {
  tier: TierSaas;
  moneda: MonedaSaas;
  esActual: boolean;
  hayPlanActivo: boolean;
  onElegir: () => void;
}) {
  const plan = PLANES_SAAS[tier];
  const destacado = tier === 'pro';
  const precioStr = formatPrecio(precioCentavos(tier, moneda), moneda);

  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--sala-surface)',
        border: `1px solid ${
          esActual
            ? 'var(--sala-primary)'
            : destacado
              ? 'var(--sala-primary)'
              : 'var(--sala-border)'
        }`,
        boxShadow: destacado ? '0 0 0 1px var(--sala-primary)' : 'none',
        borderRadius: '16px',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}
    >
      {esActual && (
        <span
          style={{
            position: 'absolute',
            top: '-10px',
            left: '20px',
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--sala-text-on-primary)',
            background: 'var(--sala-primary)',
            padding: '4px 10px',
            borderRadius: '999px'
          }}
        >
          Tu plan actual
        </span>
      )}

      <div>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '18px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: 'var(--sala-text-primary)',
            margin: 0
          }}
        >
          {plan.nombre}
        </h3>
        <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '2px 0 0' }}>
          {plan.resumen}
        </p>
      </div>

      <div>
        <span
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '32px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            color: 'var(--sala-text-primary)'
          }}
        >
          {precioStr}
        </span>
        <span style={{ fontSize: '13px', color: 'var(--sala-text-secondary)' }}>
          {' '}/mes {moneda.toUpperCase()}
        </span>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '7px' }}>
        {plan.features.map((f) => (
          <li
            key={f}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px',
              fontSize: '13px',
              color: 'var(--sala-text-secondary)',
              lineHeight: 1.4
            }}
          >
            <span style={{ color: 'var(--sala-primary)', fontWeight: 700, flexShrink: 0 }}>✓</span>
            {f}
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onElegir}
        disabled={esActual}
        className={destacado && !esActual ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
        style={{ marginTop: 'auto', opacity: esActual ? 0.55 : 1, cursor: esActual ? 'default' : 'pointer' }}
      >
        {esActual
          ? 'Plan actual'
          : hayPlanActivo
            ? 'Cambiar a este plan'
            : `Probar ${TRIAL_DIAS} días gratis`}
      </button>
    </div>
  );
}
