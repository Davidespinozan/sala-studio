import { useEffect, useState } from 'react';
import { useToast } from '@shared/hooks/useToast';

export interface CredencialesCreadas {
  nombre: string;
  email: string;
  password: string;
}

interface Props {
  isOpen: boolean;
  credenciales: CredencialesCreadas;
  onClose: () => void;
}

function buildCredencialesText(c: CredencialesCreadas): string {
  // URL del admin: usa origin actual + /admin (cubre prod, staging, localhost).
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return [
    'EKKO Studio — Acceso al sistema',
    '',
    `Nombre: ${c.nombre}`,
    `Email: ${c.email}`,
    `Contraseña: ${c.password}`,
    '',
    `Inicia sesión en: ${origin}/login`
  ].join('\n');
}

export default function CredencialesCreadasModal({ isOpen, credenciales, onClose }: Props) {
  const toast = useToast();
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setCopiado(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  async function handleCopy() {
    const text = buildCredencialesText(credenciales);
    try {
      await navigator.clipboard.writeText(text);
      setCopiado(true);
      toast.success('Credenciales copiadas al portapapeles.');
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      toast.error('No se pudo copiar al portapapeles. Copia manualmente.');
    }
  }

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cred-creadas-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 110,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-mustard-dim)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '520px',
          width: '100%',
          padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p
          className="ek-eyebrow ek-eyebrow--mustard"
          style={{ marginBottom: '6px', color: 'var(--ek-success)' }}
        >
          ✓ ACCESO CREADO
        </p>
        <h3
          id="cred-creadas-title"
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Comparte estas credenciales con la persona
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '20px' }}>
          Cópialas ahora — por seguridad no podrás volver a ver la contraseña.
        </p>

        <div
          style={{
            background: 'var(--ek-bg-elevated)',
            border: '0.5px solid var(--ek-mustard-dim)',
            borderRadius: 'var(--ek-r-md)',
            padding: '16px 18px',
            marginBottom: '14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}
        >
          <CredField label="Nombre" value={credenciales.nombre} />
          <CredField label="Email" value={credenciales.email} mono />
          <CredField label="Contraseña" value={credenciales.password} mono />
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="ek-cta ek-cta--full"
          style={{
            padding: '12px',
            fontSize: '14px',
            marginBottom: '16px'
          }}
        >
          {copiado ? '✓ Copiado' : '📋 Copiar credenciales'}
        </button>

        <p
          style={{
            fontSize: '12px',
            color: 'var(--ek-mustard)',
            background: 'var(--ek-mustard-soft)',
            padding: '10px 12px',
            borderRadius: 'var(--ek-r-sm)',
            margin: 0,
            marginBottom: '10px',
            lineHeight: 1.5
          }}
        >
          ⚠️ Por seguridad, no podrás volver a ver esta contraseña. Si la persona la pierde,
          puede recuperarla desde el login con &quot;Olvidé mi contraseña&quot;.
        </p>

        <p
          style={{
            fontSize: '12px',
            color: 'var(--ek-ink-muted)',
            margin: 0,
            marginBottom: '20px',
            lineHeight: 1.5
          }}
        >
          💡 Sugerencia: comparte por WhatsApp o llamada, no por email.
        </p>

        <button
          type="button"
          onClick={onClose}
          className="ek-cta ek-cta--secondary ek-cta--full"
          style={{ padding: '12px', fontSize: '14px' }}
        >
          Entendido, cerrar
        </button>
      </div>
    </div>
  );
}

function CredField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'baseline' }}>
      <span
        style={{
          fontSize: '11px',
          color: 'var(--ek-ink-faint)',
          letterSpacing: '0.08em',
          fontWeight: 700,
          textTransform: 'uppercase',
          minWidth: '90px'
        }}
      >
        {label}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: '14px',
          color: 'var(--ek-ink)',
          fontFamily: mono ? 'var(--ek-font-mono)' : 'inherit',
          userSelect: 'all',
          wordBreak: 'break-all'
        }}
      >
        {value}
      </span>
    </div>
  );
}
