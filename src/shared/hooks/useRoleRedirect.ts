import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { isAdminPreview, latchAdminPreview } from '@shared/lib/adminPreview';
import { isMarketingRoot, MARKETING_DOMAIN } from '@shared/providers/TenantProvider';
import { supabase } from '@shared/lib/supabase';

// Flag de módulo: durante el alta de socio que va a pagar, suprimimos el
// redirect por rol para que el auto-login NO lo tire a /app (que mostraría
// "membresía pendiente") mientras se arma el Checkout. Se auto-resetea al salir
// a Stripe (window.location = navegación completa → el módulo se reinicia).
let suprimirRedirect = false;
export function setSuprimirRoleRedirect(v: boolean) {
  suprimirRedirect = v;
}

/**
 * Redirige al área correcta según rol después del login.
 * Útil cuando el usuario llega a / o /login estando ya autenticado.
 *
 * - admin → /admin
 * - recepcionista → /recepcion
 * - miembro → /app
 *
 * No interfiere con rutas explícitas: si el usuario ya está en /admin
 * (porque escribió la URL), no lo movemos.
 *
 * @param redirectPaths rutas donde se debe disparar el redirect
 */
export function useRoleRedirect(redirectPaths: string[] = ['/', '/login', '/signup']) {
  const { usuario, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (isLoading || !usuario) return;
    if (suprimirRedirect) return; // alta de socio yendo a pagar → no tirar a /app
    if (!redirectPaths.includes(location.pathname)) return;

    // VER COMO (Sprint D-Polish): si admin abre una vista pública con
    // ?demo=admin-preview (o ya está en modo preview sticky), NO redirigir —
    // está previsualizando. latch para que sobreviva a navegaciones sin el param.
    latchAdminPreview(location.search);
    if (isAdminPreview(location.search)) return;

    // Vista login del demo: previsualizar el login personalizado sin que el
    // redirect saque al visitante a /app aunque quede una sesión.
    if (new URLSearchParams(location.search).get('demo') === 'login-preview') return;

    const destino =
      usuario.rol === 'admin' ? '/admin'
        : usuario.rol === 'recepcionista' ? '/recepcion'
          : '/app';

    // Si entró por el dominio RAÍZ de SALA (salastudio.app), navegar a /admin
    // acá NO lo lleva a su panel: su gym vive en {slug}.salastudio.app. Ese era
    // el callejón sin salida del que abandonaba el alta en el paso del pago —
    // volvía, no se acordaba de su subdominio, y no habia forma de entrar a
    // pagar. Lo mandamos a SU gym.
    //
    // El slug se resuelve recién ACÁ, ya autenticado: es la unica forma de
    // decirle cuál es su gym sin exponer públicamente el mapa email→gym.
    if (isMarketingRoot() && usuario.tenant_id) {
      let cancelado = false;
      void (async () => {
        const { data } = await supabase
          .from('tenants')
          .select('slug')
          .eq('id', usuario.tenant_id)
          .maybeSingle();
        if (cancelado) return;
        if (data?.slug) {
          window.location.href = `https://${data.slug}.${MARKETING_DOMAIN}${destino}`;
        } else {
          navigate(destino, { replace: true }); // sin slug: mejor algo que nada
        }
      })();
      return () => { cancelado = true; };
    }

    navigate(destino, { replace: true });
  }, [usuario, isLoading, location.pathname, location.search, navigate, redirectPaths]);
}
