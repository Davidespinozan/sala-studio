import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { useAdminPreview } from '@shared/hooks/useAdminPreview';
import { isTenantFromSubdomain } from '@shared/providers/TenantProvider';

/**
 * Impide que un usuario autenticado OPERE en el subdominio de OTRO tenant.
 * Compara `usuario.tenant_id` (su cuenta) con `tenant.id` (el del subdominio):
 * si no coinciden, muestra un bloqueo + cerrar sesión, en vez de dejarlo operar
 * sobre el gimnasio equivocado (lo que confunde — branding de uno, datos de otro).
 *
 * Las RLS YA aíslan los datos (no es una fuga); esto es integridad/UX.
 *
 * Excepciones:
 *  - `?demo=admin-preview` (los "VER COMO…" del admin) → se saltea el guard.
 *  - Localhost / 127.* / *.netlify.app (dev/preview): el tenant cargado es
 *    'sala-demo' por FALLBACK, no por subdominio → no identifica al gimnasio del
 *    usuario, así que NO bloqueamos (si no, ninguna cuenta real entraría en
 *    local/preview). Solo bloqueamos cuando el subdominio es autoritativo.
 *  - Mientras el usuario no esté hidratado, deja pasar (los guards de cada
 *    layout manejan el no-auth / loading).
 */
export function TenantGuard({ children }: { children: ReactNode }) {
  const { usuario, signOut } = useAuth();
  const tenant = useTenant();
  const navigate = useNavigate();
  const isDemoPreview = useAdminPreview();

  const mismatch =
    !!usuario &&
    usuario.tenant_id !== tenant.id &&
    !isDemoPreview &&
    isTenantFromSubdomain();

  if (!mismatch) return <>{children}</>;

  const cerrarSesion = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'var(--ek-bg)',
      }}
    >
      <div style={{ maxWidth: '420px', textAlign: 'center' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>
          ACCESO BLOQUEADO
        </p>
        <h1
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '24px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
            margin: '0 0 10px',
            color: 'var(--ek-ink)',
          }}
        >
          Tu cuenta no pertenece a este gimnasio
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', lineHeight: 1.5, margin: '0 0 20px' }}>
          Estás intentando entrar a <strong>{tenant.nombre}</strong> con una cuenta de otro
          negocio. Cerrá sesión e ingresá desde el sitio de tu gimnasio.
        </p>
        <button onClick={cerrarSesion} className="ek-cta ek-cta--full">
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
