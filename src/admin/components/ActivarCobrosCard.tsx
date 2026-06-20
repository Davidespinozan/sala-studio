import { useCallback, useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, Clock } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { esTenantDemo } from '@shared/lib/demoAuth';
import { monedaDelTenant } from '@shared/lib/planesSaas';
import { obtenerEstadoConnect, iniciarOnboardingConnect, type ConnectEstado } from '../lib/connectService';

const PAIS_POR_MONEDA: Record<string, string> = { mxn: 'MX', usd: 'US', eur: 'ES' };

/**
 * Flujo 2 — "Activá cobros" (Stripe Connect Express). El gym conecta su cuenta
 * para cobrarle a sus socios; SALA nunca toca los fondos. Muestra el estado del
 * onboarding y dispara el flujo hospedado de Stripe. Inerte hasta conectar Stripe
 * (muestra "pago en camino"); en el DEMO solo informa.
 */
export function ActivarCobrosCard() {
  const tenant = useTenant();
  const toast = useToast();
  const esDemo = esTenantDemo(tenant.slug);
  const [estado, setEstado] = useState<ConnectEstado | null>(null);
  const [cargando, setCargando] = useState(!esDemo);
  const [procesando, setProcesando] = useState(false);

  const refrescar = useCallback(async () => {
    setCargando(true);
    try {
      setEstado(await obtenerEstadoConnect());
    } catch {
      setEstado(null);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (esDemo) return;
    void refrescar();
    // Retorno del onboarding hospedado.
    const params = new URLSearchParams(window.location.search);
    const c = params.get('connect');
    if (c === 'done') toast.success('¡Gracias! Estamos verificando tu cuenta de cobros.');
    if (c) {
      params.delete('connect');
      const q = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (q ? `?${q}` : ''));
    }
  }, [esDemo, refrescar, toast]);

  async function activar() {
    setProcesando(true);
    try {
      const country = PAIS_POR_MONEDA[monedaDelTenant(tenant)] ?? 'MX';
      const res = await iniciarOnboardingConnect({ country, returnPath: window.location.pathname });
      if (res.url) return; // redirigiendo a Stripe
      if (res.reason === 'stripe_pendiente') {
        toast.success('Cobros en camino — estamos conectando Stripe. Te avisamos.');
      }
    } catch {
      toast.error('No pudimos iniciar la activación. Probá de nuevo.');
    } finally {
      setProcesando(false);
    }
  }

  const activos = estado?.charges_enabled === true;
  const enVerificacion = estado?.details_submitted === true && !activos && estado?.reason !== 'stripe_pendiente';

  return (
    <div
      style={{
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '16px',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span
          style={{
            display: 'inline-flex',
            width: 38,
            height: 38,
            borderRadius: '10px',
            alignItems: 'center',
            justifyContent: 'center',
            background: activos ? 'var(--sala-success-bg)' : 'var(--sala-primary-light)',
            color: activos ? 'var(--sala-success)' : 'var(--sala-primary)'
          }}
        >
          {activos ? <CheckCircle2 size={20} /> : enVerificacion ? <Clock size={20} /> : <CreditCard size={20} />}
        </span>
        <div>
          <p className="ek-eyebrow" style={{ margin: 0 }}>COBROS A TUS SOCIOS</p>
          <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--sala-text-primary)', margin: '2px 0 0' }}>
            {activos ? 'Cobros activos' : enVerificacion ? 'Verificación en proceso' : 'Cobrá a tus socios'}
          </h3>
        </div>
      </div>

      {esDemo ? (
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, lineHeight: 1.5 }}>
          En tu gym real, acá conectás tu cuenta y los pagos de tus socios van directo a tu banco — SALA nunca toca el dinero. (Demo: no se activa nada.)
        </p>
      ) : cargando ? (
        <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: 0 }}>Cargando…</p>
      ) : activos ? (
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, lineHeight: 1.5 }}>
          Tus socios pueden pagarte desde la app. Los depósitos van a tu banco según tu calendario en Stripe.
        </p>
      ) : (
        <>
          <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, lineHeight: 1.5 }}>
            {enVerificacion
              ? 'Ya enviaste tus datos. Stripe está verificando tu cuenta — puede tardar un poco. Si falta algo, continuá el formulario.'
              : 'Conectá tu cuenta (3 minutos, formulario de Stripe con tu nombre, banco e identificación). Los pagos van directo a vos; SALA nunca toca los fondos.'}
          </p>
          <button
            type="button"
            onClick={activar}
            disabled={procesando}
            className="ek-cta"
            style={{ alignSelf: 'flex-start', minHeight: '40px', opacity: procesando ? 0.7 : 1 }}
          >
            {procesando ? 'Abriendo…' : enVerificacion ? 'Continuar verificación' : 'Activar cobros'}
          </button>
        </>
      )}
    </div>
  );
}
