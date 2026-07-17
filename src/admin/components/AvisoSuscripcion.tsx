import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import type { EstadoAccesoSaas, MotivoSaas } from '../lib/accesoSaas';

/**
 * Barra de aviso (NO bloqueante) del panel del gym cuando la suscripción entró
 * en la ventana de gracia o el trial está por vencer. El corte real (paywall)
 * llega recién cuando se acaban los días — este banner es el que le da tiempo y
 * le dice qué hacer, para no cortarle el negocio de sorpresa.
 */
function mensaje(motivo: MotivoSaas, dias: number): { texto: string; cta: string; grave: boolean } {
  const d = `${dias} ${dias === 1 ? 'día' : 'días'}`;
  switch (motivo) {
    case 'trial_por_vencer':
      return {
        texto: `Tu prueba gratis está por terminar. Agregá tu tarjeta para no perder el acceso a tu panel.`,
        cta: 'Activar mi plan',
        grave: false
      };
    case 'trial_vencido':
      return {
        texto: `Tu prueba terminó. Te quedan ${d} para activar tu plan antes de que se corte el acceso a tu panel.`,
        cta: 'Activar mi plan',
        grave: true
      };
    case 'cancelada':
      return {
        texto: `Tu plan está cancelado. Podés seguir usando el panel ${d} más; reactivá para no perder el acceso.`,
        cta: 'Reactivar mi plan',
        grave: true
      };
    case 'vencida':
      return {
        texto: `No pudimos cobrar tu plan. Actualizá el pago en los próximos ${d} o se cortará el acceso a tu panel.`,
        cta: 'Actualizar pago',
        grave: true
      };
  }
}

export function AvisoSuscripcion({ acceso }: { acceso: EstadoAccesoSaas }) {
  if (acceso.nivel !== 'aviso' || !acceso.motivo) return null;

  const { texto, cta, grave } = mensaje(acceso.motivo, acceso.diasParaCorte ?? 0);
  const color = grave ? 'var(--sala-error)' : 'var(--sala-warning)';

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
        padding: '11px 16px',
        borderBottom: `1px solid ${color}`,
        background: grave ? 'var(--sala-error-bg, var(--sala-surface))' : 'var(--sala-warning-bg, var(--sala-surface))'
      }}
    >
      <AlertTriangle size={16} strokeWidth={2.25} style={{ color, flexShrink: 0 }} aria-hidden="true" />
      <p style={{ flex: 1, minWidth: '200px', margin: 0, fontSize: '13px', color: 'var(--sala-text-primary)', lineHeight: 1.45 }}>
        {texto}
      </p>
      <Link
        to="/admin/suscripcion"
        className="ek-cta"
        style={{ fontSize: '12.5px', padding: '7px 14px', whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        {cta}
      </Link>
    </div>
  );
}