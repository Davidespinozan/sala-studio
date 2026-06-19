import { useState, FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { AuthShell } from '../components/AuthShell';
import { validarEmail } from '../lib/recuperacionLogic';

export default function RecuperarContrasena() {
  const [email, setEmail] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const v = validarEmail(email);
    if (!v.ok) {
      setError(v.error ?? 'El email no es válido.');
      return;
    }

    setEnviando(true);
    // El enlace del email vuelve a /nueva-contrasena EN ESTE subdominio —
    // así la recuperación se mantiene en el gym correcto (multi-tenant).
    const redirectTo = `${window.location.origin}/nueva-contrasena`;
    const { error: err } = await supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo }
    );
    setEnviando(false);

    // Rate limit: sí lo mostramos (no revela si el email existe).
    if (err && /rate|too many/i.test(err.message)) {
      setError('Demasiados intentos. Espera unos minutos.');
      return;
    }
    if (err) console.error('[recuperar-contrasena]', err);

    // SEGURIDAD: mostramos el mismo mensaje exista o no el email — para no
    // revelar qué direcciones están registradas.
    setEnviado(true);
  }

  return (
    <AuthShell>
      {enviado ? (
        <div className="ek-stack-md">
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>
            REVISÁ TU CORREO
          </p>
          <h2 className="ek-h3" style={{ margin: 0 }}>Enlace enviado</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Si existe una cuenta con ese email, te enviamos un enlace para
            restablecer tu contraseña. Revisa tu correo (y la carpeta de spam).
          </p>
          <Link
            to="/login"
            style={{ fontSize: '13px', color: 'var(--ek-mustard)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <ArrowLeft size={14} strokeWidth={2.25} />
            Volver al login
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="ek-stack-md">
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>
            RECUPERAR CONTRASEÑA
          </p>
          <h2 className="ek-h3" style={{ margin: 0 }}>¿Olvidaste tu contraseña?</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Ingresa tu email y te enviamos un enlace para crear una nueva.
          </p>

          <div className="ek-form-field">
            <label htmlFor="rec-email" className="ek-label">Email</label>
            <input
              id="rec-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="ek-input"
              placeholder="tu@email.com"
            />
          </div>

          {error && <p className="ek-error-text">{error}</p>}

          <button
            type="submit"
            className="ek-cta ek-cta--full"
            disabled={enviando || !email}
          >
            {enviando ? 'Enviando…' : 'Enviar enlace de recuperación'}
          </button>

          <Link
            to="/login"
            style={{
              fontSize: '13px',
              color: 'var(--ek-mustard)',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '5px'
            }}
          >
            <ArrowLeft size={14} strokeWidth={2.25} />
            Volver al login
          </Link>
        </form>
      )}
    </AuthShell>
  );
}
