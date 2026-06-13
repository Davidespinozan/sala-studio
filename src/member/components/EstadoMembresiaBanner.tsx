import { useMembresiaActual, membresiaEstado, type EstadoMembresia } from '@member/hooks/useMembresiaActual';
import ContactoGymCTA from './ContactoGymCTA';

/**
 * Banner persistente en el layout del socio. SOLO informativo: si la
 * membresía está en estado problemático (vencida / saldo 0 / pausada /
 * sin membresía), muestra un mensaje "contactá al gimnasio". Si está
 * sana, retorna null (no molesta).
 *
 * NO toca el control de acceso del MemberLayout — el socio con membresía
 * vencida tiene status='activo' y puede navegar. El gate del backend
 * (reservar_clase_atomic, Fase 2A.2) es el que bloquea al intentar
 * reservar. Este banner solo informa.
 *
 * Sin botón de pago — Stripe no existe aún. Cuando se integre, los
 * mensajes pasarán a CTA de renovación/recarga.
 */
export default function EstadoMembresiaBanner() {
  const { membresia, isLoading } = useMembresiaActual();
  if (isLoading) return null;

  const estado = membresiaEstado(membresia);
  if (estado === 'sana') return null;

  const { variant, eyebrow, mensaje, waMensaje } = bannerContenido(estado);

  // Paleta según gravedad (mismo lenguaje visual que "Restricción activa"
  // en Dashboard.tsx). Vencida y sin membresía van con error (rojo);
  // congelada y sin créditos con warning (mostaza).
  const colors =
    variant === 'error'
      ? {
          bg: 'var(--sala-error-bg)',
          border: 'var(--sala-error-glow)',
          eye: 'var(--sala-error)'
        }
      : {
          bg: 'var(--sala-warning-bg)',
          border: 'var(--sala-warning-glow)',
          eye: 'var(--sala-warning)'
        };

  return (
    <div
      role="status"
      aria-label="Estado de tu membresía"
      style={{
        background: colors.bg,
        borderBottom: `1px solid ${colors.border}`,
        padding: '12px 20px'
      }}
    >
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>
        <p
          style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: colors.eye,
            margin: 0,
            marginBottom: '4px'
          }}
        >
          {eyebrow}
        </p>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--sala-text-primary)',
            margin: 0,
            lineHeight: 1.45
          }}
        >
          {mensaje}
        </p>
        <div style={{ marginTop: '10px' }}>
          <ContactoGymCTA mensaje={waMensaje} label="Escribir al gimnasio" variant="inline" />
        </div>
      </div>
    </div>
  );
}

function bannerContenido(estado: Exclude<EstadoMembresia, 'sana'>): {
  variant: 'error' | 'warning';
  eyebrow: string;
  mensaje: string;
  waMensaje: string;
} {
  switch (estado) {
    case 'vencida':
      return {
        variant: 'error',
        eyebrow: 'Membresía vencida',
        mensaje: 'Tu membresía venció. Contactá al gimnasio para renovar.',
        waMensaje: 'Hola, mi membresía venció y quiero renovarla.'
      };
    case 'sin_membresia':
      return {
        variant: 'error',
        eyebrow: 'Sin membresía activa',
        mensaje: 'No tenés una membresía activa. Contactá al gimnasio.',
        waMensaje: 'Hola, quiero activar una membresía.'
      };
    case 'congelada':
      return {
        variant: 'warning',
        eyebrow: 'Membresía pausada',
        mensaje: 'Tu membresía está pausada. Contactá al gimnasio.',
        waMensaje: 'Hola, mi membresía está pausada y quiero reactivarla.'
      };
    case 'sin_creditos':
      return {
        variant: 'warning',
        eyebrow: 'Sin clases disponibles',
        mensaje: 'Te quedaste sin clases. Contactá al gimnasio para recargar.',
        waMensaje: 'Hola, me quedé sin clases y quiero recargar mi paquete.'
      };
  }
}
