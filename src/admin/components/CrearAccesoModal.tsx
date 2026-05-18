import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';

type Rol = 'admin' | 'recepcionista';

export interface CredencialesCreadas {
  nombre: string;
  email: string;
  password: string;
}

interface Props {
  onClose: () => void;
  onSuccess: (credenciales: CredencialesCreadas) => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CrearAccesoModal({ onClose, onSuccess }: Props) {
  const tenant = useTenant();
  const toast = useToast();

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rol, setRol] = useState<Rol>('recepcionista');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, submitting]);

  const nombreValido = nombre.trim().length >= 2;
  const emailValido = EMAIL_REGEX.test(email.trim());
  const passwordValida = password.length >= 8;
  const passwordsMatch = password === confirmPassword;
  const passwordError =
    confirmPassword.length > 0 && !passwordsMatch ? 'Las contraseñas no coinciden.' : null;

  const canSubmit = nombreValido && emailValido && passwordValida && passwordsMatch && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Sesión expirada. Inicia sesión nuevamente.');
      }

      const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
      if (!url) {
        throw new Error('VITE_SUPABASE_URL no configurada.');
      }

      const emailNorm = email.trim().toLowerCase();
      const nombreNorm = nombre.trim();

      const response = await fetch(`${url}/functions/v1/create-team-member`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          email: emailNorm,
          password,
          nombre: nombreNorm,
          rol,
          tenant_id: tenant.id
        })
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        const msg =
          response.status === 409
            ? 'Ya existe un usuario con este email en el tenant.'
            : (result?.error as string) || `Error creando acceso (HTTP ${response.status})`;
        throw new Error(msg);
      }

      onSuccess({ nombre: nombreNorm, email: emailNorm, password });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '560px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>
          CREAR ACCESO
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '22px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '20px'
          }}
        >
          Nueva persona del equipo
        </h3>

        <div className="ek-form-field" style={{ marginBottom: '14px' }}>
          <label className="ek-label">Nombre completo</label>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="ek-input"
            placeholder="Juan Pérez"
            required
            minLength={2}
            disabled={submitting}
            autoComplete="name"
          />
        </div>

        <div className="ek-form-field" style={{ marginBottom: '14px' }}>
          <label className="ek-label">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="ek-input"
            placeholder="juan@correo.com"
            required
            disabled={submitting}
            autoComplete="email"
          />
        </div>

        <div className="ek-form-field" style={{ marginBottom: '14px' }}>
          <label className="ek-label">Contraseña temporal</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="ek-input"
              placeholder="Mínimo 8 caracteres"
              required
              minLength={8}
              disabled={submitting}
              autoComplete="new-password"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="ek-icon-btn"
              aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              style={{ width: '44px', padding: 0, fontSize: '16px' }}
            >
              {showPassword ? '🙈' : '👁'}
            </button>
          </div>
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Mínimo 8 caracteres. Compártela con la persona; ella podrá cambiarla desde el login.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginBottom: '20px' }}>
          <label className="ek-label">Confirmar contraseña</label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="ek-input"
            placeholder="Repite la contraseña"
            required
            disabled={submitting}
            autoComplete="new-password"
          />
          {passwordError && (
            <p style={{ fontSize: '11px', color: 'var(--ek-danger)', marginTop: '6px' }}>
              {passwordError}
            </p>
          )}
        </div>

        <div className="ek-form-field" style={{ marginBottom: '20px' }}>
          <label className="ek-label" style={{ marginBottom: '10px' }}>Rol</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {(
              [
                {
                  value: 'admin' as const,
                  label: 'Administrador',
                  desc: 'Acceso completo: edita landing, miembros, planes, reglas, equipo. Puede crear accesos para otros admins.'
                },
                {
                  value: 'recepcionista' as const,
                  label: 'Recepcionista',
                  desc: 'Acceso operativo: check-in de miembros, ver lista del día. No edita configuración.'
                }
              ]
            ).map((opt) => (
              <label
                key={opt.value}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                  padding: '12px',
                  border: `0.5px solid ${rol === opt.value ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                  background: rol === opt.value ? 'var(--ek-mustard-soft)' : 'var(--ek-bg-elevated)',
                  borderRadius: 'var(--ek-r-md)',
                  cursor: 'pointer',
                  transition: 'all 0.18s ease'
                }}
              >
                <input
                  type="radio"
                  name="rol"
                  value={opt.value}
                  checked={rol === opt.value}
                  onChange={() => setRol(opt.value)}
                  style={{ marginTop: '3px', accentColor: 'var(--ek-mustard)' }}
                />
                <div>
                  <p
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      margin: 0,
                      marginBottom: '4px',
                      color: rol === opt.value ? 'var(--ek-mustard)' : 'var(--ek-ink)'
                    }}
                  >
                    {opt.label}
                  </p>
                  <p
                    style={{
                      fontSize: '12px',
                      color: 'var(--ek-ink-muted)',
                      margin: 0,
                      lineHeight: 1.5
                    }}
                  >
                    {opt.desc}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {error && (
          <p className="ek-error-text" style={{ marginBottom: '12px' }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button type="submit" disabled={!canSubmit} className="ek-cta" style={{ flex: 1 }}>
            {submitting ? 'Creando…' : 'Crear acceso'}
          </button>
        </div>
      </form>
    </div>
  );
}
