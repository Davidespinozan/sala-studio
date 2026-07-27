import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { TenantLogo } from '@shared/components/TenantLogo';
import { PoweredBySala } from '@shared/components/PoweredBySala';
import { PasswordInput } from '@shared/components/PasswordInput';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * ACTIVAR MI CUENTA — para socios que ya existen en el gym (importados de otro
 * sistema o dados de alta por recepción) pero todavía no tienen login. Ponen su
 * email + una contraseña; si hay una ficha pendiente con ese email, se crea el
 * acceso y queda enganchado a su membresía. No es un registro abierto.
 */
export default function ActivarCuenta() {
  const navigate = useNavigate();
  const tenant = useTenant();
  const tieneIsotipo = typeof (tenant.branding as Record<string, unknown> | null)?.isotipo_url === 'string';

  const [email, setEmail] = useState('');
  const [codigo, setCodigo] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!codigo.trim()) { setError('Escribe el código que te dio el gimnasio.'); return; }
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres.'); return; }
    if (password !== confirm) { setError('Las contraseñas no coinciden.'); return; }

    setIsSubmitting(true);
    try {
      await backendPost('reclamar-cuenta', { email: email.trim(), codigo: codigo.trim(), password, slug: tenant.slug });
      // Vinculada: entramos con la contraseña recién creada.
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) {
        // La cuenta quedó creada; que inicie sesión a mano.
        navigate('/login', { replace: true });
        return;
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos activar tu cuenta. Intenta de nuevo.');
      setIsSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px' }}>
      <div style={{ maxWidth: '400px', width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '40px' }}>
          {tieneIsotipo
            ? <TenantLogo variant="isotipo" height={112} />
            : <TenantLogo variant="completo" height={60} fallbackFontSize={42} showSuffix />}
        </div>

        <div
          className="ek-card"
          style={{
            background: 'linear-gradient(160deg, var(--sala-surface) 0%, var(--sala-primary-light) 100%)',
            border: '1px solid var(--sala-primary-soft)',
            boxShadow: '0 12px 32px var(--sala-primary-dim)'
          }}
        >
          <div style={{ marginBottom: 16 }}>
            <p className="ek-eyebrow" style={{ margin: 0 }}>YA SOY SOCIO</p>
            <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: 22, fontWeight: 700, margin: '4px 0 0' }}>Activa tu cuenta</h1>
            <p style={{ fontSize: 13, color: 'var(--sala-text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
              Usa tu email y el <strong>código de activación</strong> que te dio {tenant.nombre || 'el gimnasio'}, y crea tu contraseña.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="ek-stack-md">
            <div className="ek-form-field">
              <label htmlFor="email" className="ek-label">Email</label>
              <input id="email" type="email" autoComplete="email" required value={email}
                onChange={(e) => setEmail(e.target.value)} className="ek-input" placeholder="tu@email.com" />
            </div>

            <div className="ek-form-field">
              <label htmlFor="codigo" className="ek-label">Código de activación</label>
              <input id="codigo" type="text" required value={codigo}
                onChange={(e) => setCodigo(e.target.value)} className="ek-input" placeholder="El que te dio el gimnasio"
                style={{ textTransform: 'uppercase' }} autoCapitalize="characters" />
            </div>

            <div className="ek-form-field">
              <label htmlFor="password" className="ek-label">Nueva contraseña</label>
              <PasswordInput id="password" autoComplete="new-password" required minLength={8}
                value={password} onChange={setPassword} placeholder="Al menos 8 caracteres" />
            </div>

            <div className="ek-form-field">
              <label htmlFor="confirm" className="ek-label">Repite la contraseña</label>
              <PasswordInput id="confirm" autoComplete="new-password" required minLength={8}
                value={confirm} onChange={setConfirm} placeholder="••••••••" />
            </div>

            {error && <p className="ek-error-text">{error}</p>}

            <button type="submit" className="ek-cta ek-cta--full ek-cta--solid"
              disabled={isSubmitting || !email || !password || !confirm}>
              {isSubmitting ? 'Activando…' : 'Activar mi cuenta'}
            </button>

            <div style={{ textAlign: 'center', marginTop: 6 }}>
              <Link to="/login" style={{ fontSize: 13, color: 'var(--ek-mustard)', textDecoration: 'none' }}>
                ¿Ya tienes acceso? Inicia sesión
              </Link>
            </div>
          </form>
        </div>

        <PoweredBySala />
      </div>
    </div>
  );
}
