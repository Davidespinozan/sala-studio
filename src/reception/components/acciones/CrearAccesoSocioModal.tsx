import { useEffect, useRef, useState } from 'react';
import QRCodeStyling from 'qr-code-styling';
import { backendPost } from '@shared/lib/backend';
import { esCorreoMarcador } from '@shared/lib/sinCorreo';
import { PASSWORD_TEMPORAL_INICIAL } from '@shared/lib/acceso';

interface Props {
  socioId: string;
  socioNombre: string;
  emailActual: string | null;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Recepción le da acceso a la app a un socio que aún no tiene login. Le pone (o
 * confirma) su email y le crea el login con la contraseña temporal fija. El socio
 * está en el mostrador, así que el staff lo verifica en persona — sin código. Al
 * entrar, la app lo obliga a cambiar esa contraseña.
 */
export function CrearAccesoSocioModal({ socioId, socioNombre, emailActual, isOpen, onClose, onDone }: Props) {
  const sinCorreo = esCorreoMarcador(emailActual ?? '');
  const [email, setEmail] = useState(sinCorreo ? '' : (emailActual ?? ''));
  const [creado, setCreado] = useState<{ email: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setEmail(sinCorreo ? '' : (emailActual ?? ''));
    setCreado(null); setError(null); setSubmitting(false);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const emailOk = EMAIL_RE.test(email.trim());
  const loginUrl = `${window.location.origin}/login`;

  async function crear() {
    setSubmitting(true);
    setError(null);
    try {
      await backendPost('recepcion-crear-acceso', {
        usuario_id: socioId,
        email: email.trim().toLowerCase(),
        password: PASSWORD_TEMPORAL_INICIAL
      });
      setCreado({ email: email.trim().toLowerCase() });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear el acceso.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => !submitting && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(26, 31, 28, 0.55)',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', zIndex: 110,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)', border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)', maxWidth: '440px', width: '100%', padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow" style={{ color: 'var(--ek-ink-muted)', marginBottom: '8px' }}>
          {creado ? 'ACCESO CREADO' : 'DAR ACCESO A LA APP'}
        </p>
        <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 12px', color: 'var(--ek-ink)' }}>
          {creado ? 'Listo, así entra el socio' : `Crear login de ${socioNombre}`}
        </h3>

        {creado ? (
          <>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', lineHeight: 1.55, margin: '0 0 14px' }}>
              Pásale estos datos al socio:
            </p>

            {/* CÓMO entra: dirección + QR para abrirla sin teclear. */}
            <div style={{ display: 'flex', gap: '14px', alignItems: 'center', background: 'var(--sala-surface)', border: '0.5px solid var(--ek-line)', borderRadius: '12px', padding: '14px', marginBottom: '10px' }}>
              <QrMini data={loginUrl} />
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: '11px', color: 'var(--ek-ink-muted)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Abre en el celular</p>
                <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--sala-text-primary)', margin: '2px 0 0', wordBreak: 'break-all' }}>{loginUrl}</p>
                <p style={{ fontSize: '11.5px', color: 'var(--sala-text-tertiary)', margin: '6px 0 0', lineHeight: 1.4 }}>Escanea el QR o escribe la dirección.</p>
              </div>
            </div>

            {/* Sus credenciales. */}
            <div style={{ background: 'var(--sala-surface)', border: '0.5px solid var(--ek-line)', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '12px' }}>
              <Dato label="Email" valor={creado.email} />
              <Dato label="Contraseña temporal" valor={PASSWORD_TEMPORAL_INICIAL} />
            </div>

            <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', lineHeight: 1.5, margin: '0 0 16px' }}>
              La primera vez, la app le pedirá cambiar esa contraseña por una suya.
            </p>

            <button type="button" onClick={onClose} className="ek-cta" style={{ width: '100%' }}>
              Listo
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', lineHeight: 1.55, margin: '0 0 16px' }}>
              {sinCorreo
                ? 'Este socio se importó sin correo. Ponle su email y le creamos el acceso.'
                : 'Le creamos el login para que reserve desde la app.'}
            </p>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block' }}>
                <span className="ek-label" style={{ display: 'block', marginBottom: '5px' }}>Email de acceso</span>
                <input className="ek-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" placeholder="socio@email.com" autoFocus={sinCorreo} />
              </label>
              <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '8px 0 0', lineHeight: 1.45 }}>
                Contraseña temporal: <strong style={{ fontFamily: 'var(--ek-font-mono)' }}>{PASSWORD_TEMPORAL_INICIAL}</strong> (la cambia al entrar).
              </p>
            </div>

            {error && (
              <p style={{ color: 'var(--ek-danger)', background: 'var(--ek-danger-soft)', border: '0.5px solid var(--sala-error-glow)', borderRadius: 'var(--ek-r-md)', padding: '10px 12px', fontSize: '0.875rem', margin: '0 0 16px' }}>
                {error}
              </p>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={() => !submitting && onClose()} disabled={submitting} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
                Cancelar
              </button>
              <button type="button" onClick={crear} disabled={!emailOk || submitting} className="ek-cta" style={{ flex: 1, opacity: (!emailOk || submitting) ? 0.4 : 1 }}>
                {submitting ? 'Creando…' : 'Crear acceso'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Dato({ label, valor }: { label: string; valor: string }) {
  return (
    <div>
      <p style={{ fontSize: '11px', color: 'var(--ek-ink-muted)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</p>
      <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--sala-text-primary)', margin: '2px 0 0', fontFamily: 'var(--ek-font-mono)' }}>{valor}</p>
    </div>
  );
}

/** QR chico que abre la dirección de login del gym (para que el socio no la teclee). */
function QrMini({ data }: { data: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const qr = new QRCodeStyling({
      width: 92, height: 92, type: 'svg', data, margin: 4,
      dotsOptions: { color: '#0A0A0A', type: 'square' },
      backgroundOptions: { color: '#FFFFFF' },
      qrOptions: { errorCorrectionLevel: 'M' }
    });
    ref.current.innerHTML = '';
    qr.append(ref.current);
  }, [data]);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ flexShrink: 0, width: 92, height: 92, borderRadius: 8, overflow: 'hidden', background: '#fff' }}
    />
  );
}