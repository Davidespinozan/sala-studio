import { useAuth } from '@shared/hooks/useAuth';
import { esSesionDemo } from '@shared/lib/demoAuth';

/**
 * Barra superior visible solo cuando la sesión es la cuenta demo. Recuerda que
 * es un gimnasio de ejemplo y empuja a convertir ("Creá tu gym").
 */
export function ModoDemoBanner() {
  const { authUser, signOut } = useAuth();
  if (!esSesionDemo(authUser)) return null;

  const salir = async () => {
    await signOut();
    window.location.href = '/';
  };

  return (
    <div className="modo-demo-banner">
      <span className="modo-demo-banner__msg">
        <span aria-hidden="true">🎬</span>
        <span>Modo demo · estás explorando un gimnasio de ejemplo.</span>
      </span>
      <span className="modo-demo-banner__actions">
        <a
          href="/registro"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '5px 14px',
            lineHeight: 1,
            borderRadius: '999px',
            background: 'var(--sala-primary-text)',
            color: 'var(--sala-primary)',
            textDecoration: 'none',
            fontWeight: 700
          }}
        >
          Creá tu gym
        </a>
        <button
          type="button"
          onClick={salir}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '5px 14px',
            lineHeight: 1,
            borderRadius: '999px',
            border: '1px solid rgba(255,255,255,0.5)',
            background: 'transparent',
            color: 'var(--sala-primary-text)',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit'
          }}
        >
          Salir
        </button>
      </span>
    </div>
  );
}
