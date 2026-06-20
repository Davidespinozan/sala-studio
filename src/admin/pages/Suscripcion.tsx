import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { esTenantDemo } from '@shared/lib/demoAuth';
import { useSuscripcion } from '../hooks/useSuscripcion';
import { iniciarCheckoutSaas } from '../lib/suscripcionService';
import { CheckoutModalMock } from '../components/CheckoutModalMock';
import { EstadoSuscripcionCard } from '../components/EstadoSuscripcionCard';
import {
  PLANES_SAAS,
  TIERS_ORDEN,
  TRIAL_DIAS,
  formatPrecio,
  precioCentavos,
  monedaDelTenant,
  type TierSaas,
  type MonedaSaas
} from '@shared/lib/planesSaas';

export default function Suscripcion() {
  const tenant = useTenant();
  const toast = useToast();
  const { suscripcion, uso, isLoading, refetch } = useSuscripcion();

  // La moneda la fija el MERCADO del gym (su timezone), no es elegible.
  const moneda = monedaDelTenant(tenant);
  const esDemo = esTenantDemo(tenant.slug);
  const [checkout, setCheckout] = useState<TierSaas | null>(null);
  const [procesando, setProcesando] = useState<TierSaas | null>(null);

  // El tier vigente — null si no hay suscripción o está cancelada.
  const tierActual =
    suscripcion && suscripcion.estado !== 'cancelada'
      ? (suscripcion.tier as TierSaas)
      : null;

  // Retorno de Stripe Checkout (?checkout=success|cancel) → avisar + refrescar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const estado = params.get('checkout');
    if (!estado) return;
    if (estado === 'success') {
      toast.success('¡Pago confirmado! Tu plan se está activando.');
      void refetch();
    } else if (estado === 'cancel') {
      toast.error('Checkout cancelado. No se cobró nada.');
    }
    params.delete('checkout');
    const q = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (q ? `?${q}` : ''));
  }, [toast, refetch]);

  // Demo → modal mock. Real → checkout de Stripe (o "pago en camino" si Stripe
  // todavía no está conectado). El backend decide; acá solo ruteamos.
  async function elegirPlan(tier: TierSaas) {
    if (esDemo) {
      setCheckout(tier);
      return;
    }
    setProcesando(tier);
    try {
      const res = await iniciarCheckoutSaas({ tier, moneda, returnPath: window.location.pathname });
      if (res.url) return; // redirigiendo a Stripe
      if (res.reason === 'stripe_pendiente') {
        toast.success('Pago en camino — estamos conectando Stripe. Te avisamos.');
      } else if (res.activated) {
        await refetch();
        toast.success('¡Suscripción activada!');
      }
    } catch {
      toast.error('No pudimos iniciar el checkout. Probá de nuevo.');
    } finally {
      setProcesando(null);
    }
  }

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
        {esDemo && (
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
        )}
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <>
          {/* Estado de la suscripción actual + uso de miembros */}
          <EstadoSuscripcionCard suscripcion={suscripcion} uso={uso} onCambio={refetch} />

          <h2
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '16px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--sala-text-primary)',
              margin: '0 0 12px'
            }}
          >
            {tierActual ? 'Cambiar de plan' : 'Elige tu plan'}
          </h2>

          {/* Cards de planes — precios en la moneda del mercado del gym */}
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
                cargando={procesando === tier}
                onElegir={() => elegirPlan(tier)}
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
  cargando,
  onElegir
}: {
  tier: TierSaas;
  moneda: MonedaSaas;
  esActual: boolean;
  hayPlanActivo: boolean;
  cargando: boolean;
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
            <Check size={16} strokeWidth={2.5} style={{ color: 'var(--sala-primary)', flexShrink: 0, marginTop: '1px' }} />
            {f}
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onElegir}
        disabled={esActual || cargando}
        className={destacado && !esActual ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
        style={{ marginTop: 'auto', opacity: esActual ? 0.55 : 1, cursor: esActual || cargando ? 'default' : 'pointer' }}
      >
        {cargando
          ? 'Redirigiendo…'
          : esActual
            ? 'Plan actual'
            : hayPlanActivo
              ? 'Cambiar a este plan'
              : `Probar ${TRIAL_DIAS} días gratis`}
      </button>
    </div>
  );
}
