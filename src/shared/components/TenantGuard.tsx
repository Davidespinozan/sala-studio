import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { useAdminPreview } from '@shared/hooks/useAdminPreview';
import { supabase } from '@shared/lib/supabase';
import {
  isMarketingRoot,
  isTenantFromSubdomain,
  MARKETING_DOMAIN
} from '@shared/providers/TenantProvider';

/**
 * Impide que un usuario autenticado OPERE en el tenant equivocado. Compara
 * `usuario.tenant_id` (su cuenta) con `tenant.id` (el cargado por el host):
 *
 *  - En el host de MARKETING (salastudio.app), el tenant cargado es sala-demo
 *    por fallback. Si el usuario es de OTRO gym, lo REDIRIGIMOS a su subdominio
 *    (antes se quedaba operando el demo). La sesión es localStorage por origen,
 *    así que entra de nuevo en su sitio — pero en el gym correcto.
 *  - En un SUBDOMINIO autoritativo equivocado → bloqueo + cerrar sesión.
 *
 * Las RLS YA aíslan los datos (no es una fuga); esto es integridad/UX.
 *
 * Excepciones:
 *  - `?demo=admin-preview` (los "VER COMO…" del admin) → se saltea.
 *  - Localhost / 127.* / *.netlify.app: el tenant es sala-demo por FALLBACK (no
 *    identifica al gym del usuario) → no bloqueamos ni redirigimos.
 *  - Usuario sin hidratar → deja pasar (cada layout maneja el no-auth/loading).
 */
export function TenantGuard({ children }: { children: ReactNode }) {
  const { usuario, signOut } = useAuth();
  const tenant = useTenant();
  const navigate = useNavigate();
  const isDemoPreview = useAdminPreview();
  const [redirigiendo, setRedirigiendo] = useState(false);

  const mismatch = !!usuario && usuario.tenant_id !== tenant.id && !isDemoPreview;
  // En marketing (apex): el usuario de otro gym debe ir a SU subdominio.
  const debeRedirigir = mismatch && isMarketingRoot();
  // En un subdominio real equivocado: bloquear.
  const debeBloquear = mismatch && !isMarketingRoot() && isTenantFromSubdomain();

  useEffect(() => {
    if (!debeRedirigir || !usuario) return;
    let cancelado = false;
    setRedirigiendo(true);
    (async () => {
      const { data } = await supabase
        .from('tenants')
        .select('slug')
        .eq('id', usuario.tenant_id)
        .maybeSingle();
      if (cancelado) return;
      const slug = data?.slug;
      if (!slug) {
        // No se pudo resolver el subdominio → caer al bloqueo manual.
        setRedirigiendo(false);
        return;
      }
      // Cross-origin (subdominio): la sesión es por origen, así que lo mandamos
      // a SU login. window.location porque es navegación entre orígenes.
      window.location.replace(`https://${slug}.${MARKETING_DOMAIN}/login`);
    })();
    return () => {
      cancelado = true;
    };
  }, [debeRedirigir, usuario]);

  if (debeRedirigir || redirigiendo) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: 'var(--ek-bg)',
          textAlign: 'center'
        }}
      >
        <p style={{ fontSize: '15px', color: 'var(--sala-text-secondary)' }}>
          Te llevamos al sitio de tu gimnasio…
        </p>
      </div>
    );
  }

  if (!debeBloquear) return <>{children}</>;

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
