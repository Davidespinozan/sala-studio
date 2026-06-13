import { MessageCircle } from 'lucide-react';
import { useLandingConfig } from '@shared/hooks/useLandingConfig';

type Variant = 'primary' | 'secondary' | 'inline';

interface Props {
  /** Mensaje pre-cargado en el WhatsApp (ej: "Quiero renovar mi membresía"). */
  mensaje?: string;
  label?: string;
  variant?: Variant;
}

/**
 * CTA a WhatsApp del gym (de config.contacto.whatsapp_e164). Convierte los
 * estados "contactá al gimnasio" en un camino real de salida. Si el tenant no
 * configuró WhatsApp, no renderiza nada (el texto del estado igual informa).
 */
export default function ContactoGymCTA({
  mensaje,
  label = 'Escribinos por WhatsApp',
  variant = 'primary'
}: Props) {
  const { whatsappUrl } = useLandingConfig();
  const url = whatsappUrl(mensaje);
  if (!url) return null;

  if (variant === 'inline') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: 'var(--sala-primary)',
          fontWeight: 600,
          textDecoration: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px'
        }}
      >
        <MessageCircle size={14} strokeWidth={2.25} />
        {label}
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={variant === 'secondary' ? 'ek-cta ek-cta--secondary' : 'ek-cta'}
      style={{
        textDecoration: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '7px'
      }}
    >
      <MessageCircle size={16} strokeWidth={2.25} />
      {label}
    </a>
  );
}
