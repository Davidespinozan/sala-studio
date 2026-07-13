import { ActivarCobrosCard } from '../components/ActivarCobrosCard';

/**
 * COBROS — la conexión con Stripe para cobrarle a tus socios (Stripe Connect).
 *
 * Vivía enterrada al final de la página de Suscripción, que es OTRA cosa: ahí el
 * gym paga SU plan a SALA. Mezclar "lo que yo le pago a SALA" con "cómo le cobro
 * a mis socios" confundía las dos direcciones del dinero. Ahora es su propia
 * pestaña, al lado de Suscripción.
 */
export default function Cobros() {
  return (
    <div className="adm-page">
      <p className="ek-eyebrow" style={{ marginBottom: '4px' }}>CUENTA</p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(28px, 5vw, 40px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '6px'
        }}
      >
        Cobros
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '24px', lineHeight: 1.55 }}>
        Cómo le cobrás a tus socios. El dinero va directo a tu cuenta bancaria — SALA nunca lo toca.
        Para ver los cobros que ya entraron, andá a <strong>Caja</strong>.
      </p>

      <ActivarCobrosCard />
    </div>
  );
}
