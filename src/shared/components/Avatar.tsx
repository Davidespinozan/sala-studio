import { useEffect, useState, type CSSProperties } from 'react';

/** Iniciales de un nombre (o email como fallback) para el avatar sin foto. */
export function iniciales(nombre?: string | null, email?: string | null): string {
  const base = (nombre?.trim() || email?.trim() || '').trim();
  if (!base) return '?';
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

/**
 * Avatar circular de una persona. Muestra la foto (avatar_url) y, si NO hay o
 * si la URL falla (bucket 404 → E-18), cae a las iniciales — nunca el ícono de
 * imagen rota del navegador.
 */
export function Avatar({
  src,
  nombre,
  email,
  size = 44,
  className,
  style,
  fallbackBg = 'var(--sala-primary-light)',
  fallbackColor = 'var(--sala-primary)'
}: {
  src?: string | null;
  nombre?: string | null;
  email?: string | null;
  size?: number;
  className?: string;
  style?: CSSProperties;
  fallbackBg?: string;
  fallbackColor?: string;
}) {
  const [failed, setFailed] = useState(false);
  // Si cambia la foto (ej. otro socio en una lista reciclada), reintentamos.
  useEffect(() => setFailed(false), [src]);

  const dim: CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    flexShrink: 0,
    ...style
  };

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={className}
        style={{ ...dim, objectFit: 'cover' }}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        ...dim,
        background: fallbackBg,
        color: fallbackColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--ek-font-display)',
        fontWeight: 700,
        fontSize: `${Math.round(size / 2.9)}px`
      }}
    >
      {iniciales(nombre, email)}
    </div>
  );
}
