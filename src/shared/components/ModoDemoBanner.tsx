import { useAuth } from '@shared/hooks/useAuth';
import { useTenant, MARKETING_DOMAIN } from '@shared/providers/TenantProvider';
import { esSesionDemo, esTenantDemo } from '@shared/lib/demoAuth';

/**
 * Barra superior del "modo demo". Aparece en dos casos:
 *  - Vistas de app del demo (admin/miembro/recepción): la sesión es anónima
 *    (esSesionDemo) → "Salir" cierra sesión y vuelve al apex.
 *  - Landing pública del tenant demo (healthyspace): no hay sesión, pero es el
 *    gimnasio de ejemplo → "Salir/Crea tu gym" apuntan al apex de SALA.
 */
export function ModoDemoBanner() {
  const { authUser, signOut } = useAuth();
  const tenant = useTenant();
  const enSesion = esSesionDemo(authUser);
  const enLanding = !enSesion && esTenantDemo(tenant.slug);
  if (!enSesion && !enLanding) return null;

  const salir = async () => {
    if (enSesion) await signOut();
    window.location.href = enSesion ? '/' : `https://${MARKETING_DOMAIN}`;
  };
  const crearHref = enSesion ? '/registro' : `https://${MARKETING_DOMAIN}/registro`;

  return (
    <div className="modo-demo-banner">
      <span className="modo-demo-banner__msg">
        <strong>Demo</strong>
        <span className="modo-demo-banner__long">· estás explorando un gimnasio de ejemplo</span>
      </span>
      <span className="modo-demo-banner__actions">
        <a
          href={crearHref}
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
          Crea tu gym
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
