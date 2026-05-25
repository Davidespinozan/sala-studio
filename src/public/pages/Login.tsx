import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { SalaLogo } from '@shared/components/SalaLogo';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      setError('Error inesperado. Intentá de nuevo.');
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
          <SalaLogo height={56} fallbackFontSize={36} />
        </div>

        <div className="ek-card">
          <form onSubmit={handleSubmit} className="ek-stack-md">
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
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="ek-input"
                placeholder="••••••••"
              />
            </div>

            <div style={{ textAlign: 'right', marginTop: '12px' }}>
              <Link
                to="/recuperar"
                style={{
                  fontSize: '13px',
                  color: 'var(--ek-mustard)',
                  textDecoration: 'none'
                }}
              >
                ¿Olvidaste tu contraseña?
              </Link>
            </div>

            {error && <p className="ek-error-text">{error}</p>}

            <button
              type="submit"
              className="ek-cta ek-cta--full"
              disabled={isSubmitting || !email || !password}
            >
              {isSubmitting ? 'Iniciando sesión…' : 'Iniciar sesión'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function traducirError(message: string): string {
  if (message.includes('Invalid login credentials')) {
    return 'Email o contraseña incorrectos';
  }
  if (message.includes('Email not confirmed')) {
    return 'Necesitás confirmar tu email primero';
  }
  if (message.includes('Too many requests')) {
    return 'Demasiados intentos. Esperá unos minutos.';
  }
  return message;
}
