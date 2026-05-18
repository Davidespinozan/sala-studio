import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';

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
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <h1 style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '36px',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            color: 'var(--ek-mustard)',
            margin: 0
          }}>EKKO</h1>
          <p className="ek-eyebrow" style={{ marginTop: '6px' }}>STUDIO</p>
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
    return 'Necesitas confirmar tu email primero';
  }
  if (message.includes('Too many requests')) {
    return 'Demasiados intentos. Espera unos minutos.';
  }
  return message;
}
