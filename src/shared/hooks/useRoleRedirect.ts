import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { isAdminPreview, latchAdminPreview } from '@shared/lib/adminPreview';

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

    if (usuario.rol === 'admin') navigate('/admin', { replace: true });
    else if (usuario.rol === 'recepcionista') navigate('/recepcion', { replace: true });
    else navigate('/app', { replace: true });
  }, [usuario, isLoading, location.pathname, location.search, navigate, redirectPaths]);
}
