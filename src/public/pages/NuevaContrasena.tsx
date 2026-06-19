import { useEffect, useRef, useState, FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { AuthShell } from '../components/AuthShell';
import { validarNuevaContrasena, traducirErrorRecuperacion } from '../lib/recuperacionLogic';

type EstadoEnlace = 'verificando' | 'listo' | 'invalido';

export default function NuevaContrasena() {
  const navigate = useNavigate();
  const [enlace, setEnlace] = useState<EstadoEnlace>('verificando');
  const [password, setPassword] = useState('');
  const [confirmacion, setConfirmacion] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exito, setExito] = useState(false);
  const exitoRef = useRef(false);

  // Sesión efímera: el enlace de recovery crea una sesión real. Si el usuario
  // abandona sin completar el cambio, la cerramos al desmontar — si no, en un
  // dispositivo compartido quedaría logueado sin haber cambiado la contraseña.
  useEffect(() => {
    return () => {
      if (!exitoRef.current) void supabase.auth.signOut();
    };
  }, []);

  // Al venir del enlace del email, Supabase (detectSessionInUrl) deja una
  // sesión de recuperación. La detectamos por getSession + el evento de auth.
  useEffect(() => {
    let cancelado = false;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelado && session) setEnlace('listo');
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelado) return;
      if (session) {
        setEnlace('listo');
      } else {
        // Margen para que detectSessionInUrl procese el hash del enlace.
        setTimeout(() => {
          if (!cancelado) setEnlace((e) => (e === 'verificando' ? 'invalido' : e));
        }, 2500);
      }
    });

    return () => {
      cancelado = true;
      subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const v = validarNuevaContrasena(password, confirmacion);
    if (!v.ok) {
      setError(v.error ?? 'Revisa la contraseña.');
      return;
    }

    setGuardando(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setGuardando(false);

    if (err) {
      setError(traducirErrorRecuperacion(err.message));
      return;
    }
    exitoRef.current = true; // cambio completado → la sesión NO es efímera
    setExito(true);
  }

  // ── Verificando el enlace ──
  if (enlace === 'verificando') {
    return (
      <AuthShell>
        <p className="ek-body-muted" style={{ margin: 0, textAlign: 'center' }}>
          Verificando el enlace…
        </p>
      </AuthShell>
    );
  }

  // ── Enlace inválido o expirado ──
  if (enlace === 'invalido') {
    return (
      <AuthShell>
        <div className="ek-stack-md">
          <p className="ek-eyebrow" style={{ margin: 0, color: 'var(--ek-danger)' }}>
            ENLACE NO VÁLIDO
          </p>
          <h2 className="ek-h3" style={{ margin: 0 }}>El enlace expiró o no es válido</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Los enlaces de recuperación caducan por seguridad. Pide uno nuevo.
          </p>
          <Link to="/recuperar" className="ek-cta ek-cta--full" style={{ textAlign: 'center', textDecoration: 'none' }}>
            Pedir un enlace nuevo
          </Link>
          <Link
            to="/login"
            style={{ fontSize: '13px', color: 'var(--ek-mustard)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}
          >
            <ArrowLeft size={14} strokeWidth={2.25} />
            Volver al login
          </Link>
        </div>
      </AuthShell>
    );
  }

  // ── Éxito ──
  if (exito) {
    return (
      <AuthShell>
        <div className="ek-stack-md">
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>
            LISTO
          </p>
          <h2 className="ek-h3" style={{ margin: 0 }}>Contraseña actualizada</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Tu contraseña se cambió correctamente. Ya puedes entrar con la nueva.
          </p>
          <button
            type="button"
            onClick={() => navigate('/', { replace: true })}
            className="ek-cta ek-cta--full"
          >
            Ir a mi cuenta
          </button>
        </div>
      </AuthShell>
    );
  }

  // ── Formulario de nueva contraseña ──
  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="ek-stack-md">
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>
          NUEVA CONTRASEÑA
        </p>
        <h2 className="ek-h3" style={{ margin: 0 }}>Elige tu nueva contraseña</h2>

        <div className="ek-form-field">
          <label htmlFor="np-password" className="ek-label">Nueva contraseña</label>
          <input
            id="np-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="ek-input"
            placeholder="••••••••"
          />
          <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
            Mínimo 8 caracteres, con una letra y un número.
          </span>
        </div>

        <div className="ek-form-field">
          <label htmlFor="np-confirm" className="ek-label">Repite la contraseña</label>
          <input
            id="np-confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirmacion}
            onChange={(e) => setConfirmacion(e.target.value)}
            className="ek-input"
            placeholder="••••••••"
          />
        </div>

        {error && <p className="ek-error-text">{error}</p>}

        <button
          type="submit"
          className="ek-cta ek-cta--full"
          disabled={guardando || !password || !confirmacion}
        >
          {guardando ? 'Guardando…' : 'Guardar contraseña'}
        </button>
      </form>
    </AuthShell>
  );
}
