import { useState, useEffect, FormEvent } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { TenantLogo } from '@shared/components/TenantLogo';
import { PoweredBySala } from '@shared/components/PoweredBySala';
import { PasswordInput } from '@shared/components/PasswordInput';
import { useTenant } from '@shared/hooks/useTenant';
import { esTenantDemo, DEMO_LOGIN } from '@shared/lib/demoAuth';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const tenant = useTenant();
  const tieneIsotipo =
    typeof (tenant.branding as Record<string, unknown> | null)?.isotipo_url === 'string';
  // En el gym demo: pre-cargamos el socio de ejemplo para que se vea cómo luce
  // el login personalizado. `preview` = abrieron "Vista login" desde el demo:
  // es solo para MOSTRAR la pantalla, no para loguear.
  const esDemo = esTenantDemo(tenant.slug);
  const preview = new URLSearchParams(location.search).get('demo') === 'login-preview';
  const [email, setEmail] = useState(esDemo ? DEMO_LOGIN.email : '');
  const [password, setPassword] = useState(esDemo ? DEMO_LOGIN.password : '');

  // Preview del login: si quedó una sesión previa, la cerramos para mostrar la
  // pantalla logueada-out de verdad (sin esto rebotaba a /app = "se logea solo").
  useEffect(() => {
    if (preview) void supabase.auth.signOut().catch(() => {});
  }, [preview]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (signInError) {
        setError(traducirError(signInError.message));
        setIsSubmitting(false);
        return;
      }

      // El useRoleRedirect del PublicLayout mueve al área correcta según rol.
      navigate('/', { replace: true });
    } catch (err) {
      setError('Error inesperado. Intenta de nuevo.');
      setIsSubmitting(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px 20px'
    }}>
      <div style={{ maxWidth: '400px', width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '40px' }}>
          {tieneIsotipo ? (
            <TenantLogo variant="isotipo" height={112} />
          ) : (
            <TenantLogo variant="completo" height={60} fallbackFontSize={42} showSuffix />
          )}
        </div>

        <div
          className="ek-card"
          style={{
            background: 'linear-gradient(160deg, var(--sala-surface) 0%, var(--sala-primary-light) 100%)',
            border: '1px solid var(--sala-primary-soft)',
            boxShadow: '0 12px 32px var(--sala-primary-dim)'
          }}
        >
          <form onSubmit={handleSubmit} className="ek-stack-md">
            {esDemo && (
              <div
                style={{
                  background: 'var(--sala-accent-soft)',
                  border: '1px solid var(--sala-accent)',
                  borderRadius: '10px',
                  padding: '10px 12px',
                  fontSize: '12.5px',
                  lineHeight: 1.45,
                  color: 'var(--sala-text-secondary)'
                }}
              >
                <strong style={{ color: 'var(--sala-text-primary)' }}>Vista previa:</strong> así ven
                tus socios su login. Cargamos un socio de ejemplo por si quieres entrar.
              </div>
            )}
            <div className="ek-form-field">
              <label htmlFor="email" className="ek-label">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="ek-input"
                placeholder="tu@email.com"
              />
            </div>

            <div className="ek-form-field">
              <label htmlFor="password" className="ek-label">Contraseña</label>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                required
                minLength={8}
                value={password}
                onChange={setPassword}
                placeholder="••••••••"
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: '12px' }}>
              <Link
                to="/activar"
                style={{ fontSize: '13px', color: 'var(--ek-mustard)', textDecoration: 'none' }}
              >
                ¿Ya eres socio? Activa tu cuenta
              </Link>
              <Link
                to="/recuperar"
                style={{ fontSize: '13px', color: 'var(--ek-mustard)', textDecoration: 'none' }}
              >
                ¿Olvidaste tu contraseña?
              </Link>
            </div>

            {error && <p className="ek-error-text">{error}</p>}

            <button
              type="submit"
              className="ek-cta ek-cta--full ek-cta--solid"
              disabled={isSubmitting || !email || !password}
            >
              {isSubmitting ? 'Iniciando sesión…' : 'Iniciar sesión'}
            </button>
          </form>
        </div>

        <PoweredBySala />
      </div>
    </div>
  );
}

function traducirError(message: string): string {
  if (message.includes('Invalid login credentials')) {
    return 'Email o contraseña incorrectos';
  }
  if (message.includes('Email not confirmed')) {
    return 'Necesitas confirmar tu email primero';
  }
  if (message.includes('Too many requests')) {
    return 'Demasiados intentos. Espera unos minutos.';
  }
  // Genérico en español: no exponer el mensaje crudo de Supabase (inglés).
  return 'No pudimos iniciar sesión. Intenta de nuevo.';
}
