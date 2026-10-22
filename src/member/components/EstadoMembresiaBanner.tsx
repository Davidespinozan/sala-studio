import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useMembresiaActual, membresiaEstado, type EstadoMembresia } from '@member/hooks/useMembresiaActual';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { socioPuedePagarEnApp } from '@shared/lib/cobrosDelGym';
import { formatearMoneda } from '@shared/lib/dinero';
import { useMisCargosPendientes } from '@member/hooks/useMisCargosPendientes';
import ContactoGymCTA from './ContactoGymCTA';

/**
 * Banner persistente en el layout del socio. SOLO informativo: si la
 * membresía está en estado problemático (vencida / saldo 0 / pausada /
 * sin membresía), muestra un mensaje "contacta al gimnasio". Si está
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
  const { usuario } = useAuth();
  const tenant = useTenant();
  const { total: deuda } = useMisCargosPendientes();
  if (isLoading) return null;

  const estado = membresiaEstado(membresia);
  // Plan activo pero por cobrar: puede reservar, NO entrar hasta pagar.
  if (estado === 'sana' && deuda > 0) {
    return (
      <AvisoBanner
        eyebrow="Pago pendiente"
        mensaje={`Debes ${formatearMoneda(deuda)} de tu plan. Págalo en recepción al llegar: hasta entonces no podrás hacer check-in.`}
      />
    );
  }
  if (estado === 'sana') return null;

  // Cuenta recién creada que entró sin pagar (acceso_sin_plan): no "perdió" nada,
  // le falta activar el paquete. El texto dice cómo, no "contacta al gimnasio".
  const pendienteSinPlan = estado === 'sin_membresia' && usuario?.status === 'pendiente_pago';
  const { eyebrow, mensaje, waMensaje } = pendienteSinPlan
    ? contenidoPendiente(socioPuedePagarEnApp(tenant))
    : bannerContenido(estado);

  // Regla de marca: la UI usa solo primario + acento (+ neutros) — nada de
  // rojo/mostaza. El banner de estado va con el ACENTO del tenant, sin importar
  // la gravedad. Los derivados se calculan con color-mix sobre --sala-accent.
  const colors = {
    bg: 'color-mix(in srgb, var(--sala-accent) 12%, var(--sala-surface))',
    border: 'color-mix(in srgb, var(--sala-accent) 32%, transparent)',
    eye: 'var(--sala-accent)'
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
          {estado === 'sin_membresia' || estado === 'vencida' || estado === 'past_due' ? (
            // Compra/renovación/actualizar pago → Perfil.
            <Link
              to={pendienteSinPlan ? '/app/perfil?elegir=1' : '/app/perfil'}
              style={{
                color: 'var(--sala-accent)',
                fontWeight: 600,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              {pendienteSinPlan ? 'Activar mi paquete' : estado === 'vencida' ? 'Renueva tu plan' : estado === 'past_due' ? 'Actualizar mi pago' : 'Elige tu plan'}
              <ArrowRight size={15} strokeWidth={2.25} />
            </Link>
          ) : (
            <ContactoGymCTA mensaje={waMensaje} label="Escribir al gimnasio" variant="inline" />
          )}
        </div>
      </div>
    </div>
  );
}

/** Banner simple (sin CTA): mismo look que el de estado. */
function AvisoBanner({ eyebrow, mensaje }: { eyebrow: string; mensaje: string }) {
  return (
    <div
      role="status"
      aria-label={eyebrow}
      style={{
        background: 'color-mix(in srgb, var(--sala-accent) 12%, var(--sala-surface))',
        borderBottom: '1px solid color-mix(in srgb, var(--sala-accent) 32%, transparent)',
        padding: '12px 20px'
      }}
    >
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>
        <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--sala-accent)', margin: '0 0 4px' }}>
          {eyebrow}
        </p>
        <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.45 }}>{mensaje}</p>
      </div>
    </div>
  );
}

/** Cuenta creada sin plan activo: cómo activar el paquete (según si el gym cobra en la app). */
export function contenidoPendiente(cobraOnline: boolean): {
  variant: 'error' | 'warning';
  eyebrow: string;
  mensaje: string;
  waMensaje: string;
} {
  return {
    variant: 'warning',
    eyebrow: 'Tu cuenta está lista',
    mensaje: cobraOnline
      ? 'Para reservar, activa tu paquete: puedes pagarlo aquí en la app o en recepción.'
      : 'Para reservar, activa tu paquete pagándolo en recepción; ahí te lo dejan listo.',
    waMensaje: 'Hola, ya creé mi cuenta y quiero activar mi paquete.'
  };
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
        mensaje: 'Tu membresía venció. Contacta al gimnasio para renovar.',
        waMensaje: 'Hola, mi membresía venció y quiero renovarla.'
      };
    case 'sin_membresia':
      return {
        variant: 'error',
        eyebrow: 'Sin membresía activa',
        mensaje: 'No tienes una membresía activa. Contacta al gimnasio.',
        waMensaje: 'Hola, quiero activar una membresía.'
      };
    case 'congelada':
      return {
        variant: 'warning',
        eyebrow: 'Membresía pausada',
        mensaje: 'Tu membresía está pausada. Contacta al gimnasio.',
        waMensaje: 'Hola, mi membresía está pausada y quiero reactivarla.'
      };
    case 'sin_creditos':
      return {
        variant: 'warning',
        eyebrow: 'Sin clases disponibles',
        mensaje: 'Te quedaste sin clases. Contacta al gimnasio para recargar.',
        waMensaje: 'Hola, me quedé sin clases y quiero recargar mi paquete.'
      };
    case 'past_due':
      return {
        variant: 'warning',
        eyebrow: 'Pago pendiente',
        mensaje: 'No pudimos cobrar la renovación de tu plan. Revisa tu tarjeta en tu perfil.',
        waMensaje: 'Hola, tengo un pago pendiente de mi membresía.'
      };
  }
}
