import { useState } from 'react';
import { Lock } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { PLANES_SAAS, formatPrecio, precioCentavos, type TierSaas, type MonedaSaas } from '@shared/lib/planesSaas';
import { iniciarCheckoutSaas } from '../lib/suscripcionService';
import type { SuscripcionSaas } from '../hooks/useSuscripcion';
import type { MotivoBloqueo } from '../lib/accesoSaas';

const TITULO: Record<MotivoBloqueo, string> = {
  sin_tarjeta: 'Activá tu plan para empezar',
  trial_vencido: 'Tu prueba gratis terminó',
  cancelada: 'Tu plan está cancelado',
  vencida: 'Tu plan está pausado por falta de pago'
};

const DETALLE: Record<MotivoBloqueo, string> = {
  sin_tarjeta:
    'Falta registrar tu tarjeta. Tus 7 días de prueba arrancan al agregarla y hoy no se te cobra nada — podés cancelar antes de que termine.',
  trial_vencido:
    'Se acabaron tus días de prueba. Activá tu plan para seguir gestionando tu gimnasio.',
  cancelada:
    'Cancelaste tu suscripción y el período ya terminó. Reactivala cuando quieras para volver a entrar.',
  vencida:
    'No pudimos cobrar tu plan. Actualizá el pago para recuperar el acceso a tu panel.'
};

const CTA: Record<MotivoBloqueo, string> = {
  sin_tarjeta: 'Agregar mi tarjeta',
  trial_vencido: 'Reactivar mi plan',
  cancelada: 'Reactivar mi plan',
  vencida: 'Actualizar pago'
};

/**
 * Paywall del gym: reemplaza TODO el panel del admin cuando la suscripción al
 * SaaS está muerta (ver motivoBloqueoSaas). Los socios y la recepción del gym
 * NO se ven afectados: esto es solo para el dueño, que es quien paga.
 *
 * Siempre da una salida: reactivar (→ checkout de Stripe) o cerrar sesión.
 */
export function SuscripcionBloqueada({
  motivo,
  suscripcion
}: {
  motivo: MotivoBloqueo;
  suscripcion: SuscripcionSaas | null;
}) {
  const { signOut } = useAuth();
  const toast = useToast();
  const [procesando, setProcesando] = useState(false);

  const tier = (suscripcion?.tier as TierSaas) ?? 'starter';
  const moneda = (suscripcion?.moneda as MonedaSaas) ?? 'mxn';
  const plan = PLANES_SAAS[tier];
  const precioStr = formatPrecio(precioCentavos(tier, moneda), moneda);

  async function reactivar() {
    setProcesando(true);
    try {
      const res = await iniciarCheckoutSaas({ tier, moneda, returnPath: '/admin/suscripcion' });
      if (res.url) return; // redirigiendo a Stripe
      if (res.reason === 'stripe_pendiente') {
        toast.error('Estamos conectando Stripe. Probá en un rato.');
      } else if (res.activated) {
        window.location.reload();
      }
    } catch {
      toast.error('No pudimos abrir el pago. Probá de nuevo.');
    } finally {
      setProcesando(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'var(--sala-bg)'
      }}
    >
      <div
        className="ek-card ek-card--md"
        style={{ maxWidth: '420px', width: '100%', textAlign: 'center', padding: '28px 24px' }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            width: 52,
            height: 52,
            borderRadius: '14px',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--sala-primary-light)',
            color: 'var(--sala-primary)',
            marginBottom: '16px'
          }}
        >
          <Lock size={24} strokeWidth={2} />
        </span>

        <h1
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '22px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: '0 0 8px',
            color: 'var(--sala-text-primary)'
          }}
        >
          {TITULO[motivo]}
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', lineHeight: 1.55, margin: '0 0 20px' }}>
          {DETALLE[motivo]}
        </p>

        <div
          style={{
            border: '1px solid var(--sala-border)',
            borderRadius: 'var(--ek-r-md)',
            padding: '14px 16px',
            marginBottom: '20px',
            textAlign: 'left'
          }}
        >
          <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sala-text-tertiary)', margin: 0 }}>
            Tu plan
          </p>
          <p style={{ fontSize: '16px', fontWeight: 700, color: 'var(--sala-text-primary)', margin: '4px 0 0' }}>
            {plan.nombre}
            <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--sala-text-secondary)' }}>
              {' '}· {precioStr}/mes
            </span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => void reactivar()}
          disabled={procesando}
          className="ek-cta ek-cta--full"
          style={{ opacity: procesando ? 0.6 : 1 }}
        >
          {procesando ? 'Abriendo…' : CTA[motivo]}
        </button>

        <button
          type="button"
          onClick={signOut}
          className="ek-cta ek-cta--secondary ek-cta--full"
          style={{ marginTop: '10px' }}
        >
          Cerrar sesión
        </button>

        <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '16px 0 0', lineHeight: 1.5 }}>
          Tus socios y tu recepción siguen funcionando con normalidad. Esto solo afecta tu panel de
          administración.
        </p>
      </div>
    </div>
  );
}