import { useAuth } from '@shared/hooks/useAuth';
import { esSesionDemo } from '@shared/lib/demoAuth';

/**
 * Barra superior visible solo cuando la sesión es la cuenta demo. Recuerda que
 * es un gimnasio de ejemplo y empuja a convertir ("Creá tu gym").
 */
export function ModoDemoBanner() {
  const { usuario, signOut } = useAuth();
  if (!esSesionDemo(usuario?.email)) return null;

  const salir = async () => {
    await signOut();
    window.location.href = '/';
  };

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '14px',
        flexWrap: 'wrap',
        padding: '8px 16px',
        background: 'var(--sala-primary)',
        color: 'var(--sala-primary-text)',
        fontSize: '13px',
        fontWeight: 600,
        textAlign: 'center'
      }}
    >
      <span>🎬 Modo demo · estás explorando un gimnasio de ejemplo.</span>
      <span style={{ display: 'inline-flex', gap: '8px' }}>
        <a
          href="/registro"
          style={{
            padding: '4px 12px',
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
            padding: '4px 12px',
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
