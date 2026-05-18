import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';

/**
 * Redirige a /login si no hay sesión, o a /app si el usuario no es admin.
 * Espera a que `usuario` esté hidratado antes de decidir (evita redirect
 * prematuro mientras `setTimeout(0)` del fix de deadlock Supabase v2 corre).
 */
export function useAdminGuard() {
  const { authUser, usuario, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // 1. Auth aún cargando (restaurando sesión inicial)
    if (isLoading) return;

    // 2. No hay sesión → login
    if (!authUser) {
      navigate('/login', { replace: true });
      return;
    }

    // 3. Hay sesión pero usuario aún no hidratado → esperar
    //    (la query a `usuarios` corre dentro de setTimeout(0) por el
    //    fix de deadlock Supabase v2, así que hay una ventana de unos
    //    ms donde authUser existe pero usuario todavía es null)
    if (!usuario) return;

    // 4. Usuario hidratado pero rol incorrecto → redirect a app
    if (usuario.rol !== 'admin') {
      navigate('/app', { replace: true });
    }
  }, [authUser, usuario, isLoading, navigate]);

  // El layout muestra LoadingScreen hasta que tengamos certeza de admin
  const isReady = !isLoading && !!usuario && usuario.rol === 'admin';
  return { usuario, isLoading: !isReady };
}
