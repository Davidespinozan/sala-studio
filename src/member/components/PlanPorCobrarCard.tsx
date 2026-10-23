import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { formatearMoneda } from '@shared/lib/dinero';
import { cancelarPlanPorCobrar } from '@shared/lib/elegirPlanRecepcion';
import { pagarPendientesConTarjeta } from '@shared/lib/pagarPendientes';

/**
 * Plan "por cobrar": lo eligió con "Pagar en recepción" y todavía no lo paga.
 * Antes el perfil lo trataba como un plan normal: el selector salía en modo
 * "cambiar de plan" (un solo botón a Stripe que compraba OTRO paquete y dejaba
 * la deuda viva) y "Cancelar suscripción" decía que un paquete no se cancela.
 * La socia preguntaba "¿cómo pago la clase?" y no había cómo (The Core, 22-oct).
 *
 * Acá se le dice qué tiene, cuánto debe y sus dos salidas: pagar con tarjeta
 * (si el gym cobra en la app) o cancelar el plan que nunca pagó. Mientras deba,
 * no se ofrece cambiar de plan: primero se resuelve este.
 */
export function PlanPorCobrarCard({
  tierNombre,
  montoCentavos,
  cobraOnline,
  tenantNombre
}: {
  tierNombre: string;
  montoCentavos: number;
  cobraOnline: boolean;
  tenantNombre: string;
}) {
  const toast = useToast();
  const [pagando, setPagando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [cancelando, setCancelando] = useState(false);

  async function pagar() {
    if (pagando || cancelando) return;
    setPagando(true);
    try {
      const res = await pagarPendientesConTarjeta();
      if (res.url) return; // redirigió a Stripe
      if (res.reason === 'sin_cargos') {
        toast.info('Ya no tienes pagos pendientes.');
        setTimeout(() => window.location.reload(), 900);
        return;
      }
      toast.info(`Por ahora este pago se hace en recepción. Habla con ${tenantNombre}.`);
      setPagando(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No pudimos abrir el pago con tarjeta.');
      setPagando(false);
    }
  }

  async function cancelar() {
    if (cancelando || pagando) return;
    setCancelando(true);
    try {
      const res = await cancelarPlanPorCobrar();
      toast.success(
        res.prueba_liberada
          ? `Listo: cancelamos ${res.tier_nombre}. Puedes volver a elegir tu clase de prueba cuando quieras.`
          : `Listo: cancelamos ${res.tier_nombre}. No se te cobra nada.`,
        7000
      );
      // Vuelve al selector sin plan: "Pagar con tarjeta" / "Pagar en recepción".
      setTimeout(() => { window.location.href = '/app/perfil?elegir=1'; }, 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No pudimos cancelar el plan.');
      setCancelando(false);
      setConfirmando(false);
    }
  }

  return (
    <section style={{ marginTop: '20px' }}>
      <div className="ek-card" style={{ padding: '16px 18px', border: '1px solid var(--sala-primary)' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px' }}>TU PLAN ESTÁ APARTADO</p>
        <p style={{ margin: 0, fontSize: '14px', color: 'var(--sala-text-primary)', lineHeight: 1.5 }}>
          <strong>{tierNombre}</strong> · debes {formatearMoneda(montoCentavos)}. Ya puedes reservar;
          {' '}hasta que pagues no podrás entrar a clase.
        </p>
        <p style={{ margin: '6px 0 14px', fontSize: '13px', color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>
          {cobraOnline
            ? 'Págalo aquí con tarjeta o en recepción al llegar. Si cambiaste de opinión, cancélalo: no se te cobra nada.'
            : 'Págalo en recepción al llegar. Si cambiaste de opinión, cancélalo: no se te cobra nada.'}
        </p>

        {cobraOnline && (
          <button
            type="button"
            onClick={() => void pagar()}
            disabled={pagando || cancelando}
            className="ek-cta ek-cta--full ek-lift"
            style={{ opacity: pagando ? 0.6 : 1 }}
          >
            {pagando ? 'Procesando…' : `Pagar ${formatearMoneda(montoCentavos)} con tarjeta`}
            {!pagando && <ArrowRight size={16} strokeWidth={2.25} />}
          </button>
        )}

        {confirmando ? (
          <div style={{ marginTop: '12px', padding: '14px', borderRadius: 'var(--ek-r-card)', background: 'var(--sala-bg)', border: '1px solid var(--sala-border-strong)' }}>
            <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 12px', lineHeight: 1.5 }}>
              ¿Seguro? Se cancela {tierNombre} y las reservas que hayas hecho con él. No se te cobra nada.
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={() => setConfirmando(false)} disabled={cancelando} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
                Volver
              </button>
              <button
                type="button"
                onClick={() => void cancelar()}
                disabled={cancelando}
                className="ek-cta"
                style={{ flex: 1, background: 'var(--sala-error)', borderColor: 'var(--sala-error)' }}
              >
                {cancelando ? 'Cancelando…' : 'Sí, cancelar'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmando(true)}
            disabled={pagando}
            className="ek-cta ek-cta--secondary ek-cta--full"
            style={{ marginTop: cobraOnline ? '8px' : 0, color: 'var(--sala-text-secondary)' }}
          >
            Cancelar plan (aún no pagado)
          </button>
        )}
      </div>
    </section>
  );
}
