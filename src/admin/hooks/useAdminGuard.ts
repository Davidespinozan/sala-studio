import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { accesoRevocado } from '@shared/lib/accountStatus';

/**
 * Redirige a /login si no hay sesión, o a /app si el usuario no es admin.
 * Espera a que `usuario` esté hidratado antes de decidir (evita redirect
 * prematuro mientras `setTimeout(0)` del fix de deadlock Supabase v2 corre).
 *
 * Status: si el admin tiene el acceso retirado (revocado/suspendido/cancelado),
 * lo desloguea con un toast en vez de dejarlo entrar (los RPCs igual lo
 * bloquearían, pero no debe ni ver el panel). Muestra loading mientras el
 * signOut limpia la sesión; al resolver, authUser=null → redirige a /login.
 */
export function useAdminGuard() {
  const { authUser, usuario, isLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const yaCerrado = useRef(false);

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

    // 4. Acceso retirado (revocado/suspendido/cancelado) → toast + signOut.
    //    No navegamos acá: el signOut deja authUser=null y este effect vuelve
    //    a correr cayendo en el redirect a /login de arriba (sin loop).
    if (accesoRevocado(usuario.status)) {
      if (!yaCerrado.current) {
        yaCerrado.current = true;
        toast.error('Tu acceso fue revocado. Contacta al administrador.', 8000);
        void signOut();
      }
      return;
    }

    // 5. Usuario hidratado pero rol incorrecto → redirect a app
    if (usuario.rol !== 'admin') {
      navigate('/app', { replace: true });
    }
  }, [authUser, usuario, isLoading, navigate, toast, signOut]);

  // El layout muestra LoadingScreen hasta que tengamos certeza de admin con acceso.
  const isReady =
    !isLoading && !!usuario && usuario.rol === 'admin' && !accesoRevocado(usuario.status);
  return { usuario, isLoading: !isReady };
}
