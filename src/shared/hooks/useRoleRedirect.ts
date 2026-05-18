import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';

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
    if (!redirectPaths.includes(location.pathname)) return;

    // VER COMO (Sprint D-Polish): si admin abre una vista pública con
    // ?demo=admin-preview, NO redirigir — está previsualizando.
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === 'admin-preview') return;

    if (usuario.rol === 'admin') navigate('/admin', { replace: true });
    else if (usuario.rol === 'recepcionista') navigate('/recepcion', { replace: true });
    else navigate('/app', { replace: true });
  }, [usuario, isLoading, location.pathname, location.search, navigate, redirectPaths]);
}
