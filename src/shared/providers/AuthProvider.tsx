import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';

import { COLUMNAS_USUARIO_CLIENTE } from '@shared/lib/usuariosSelect';
import { setSentryUser } from '@shared/lib/sentry';

type Usuario = Database['public']['Tables']['usuarios']['Row'];

interface AuthContextValue {
  session: Session | null;
  authUser: User | null;
  usuario: Usuario | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  authUser: null,
  usuario: null,
  isLoading: true,
  signOut: async () => {}
});

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Provee sesión + usuario hidratado desde la tabla `usuarios`.
 *
 * IMPORTANTE — Auth deadlock fix de Supabase JS v2:
 * Dentro del callback de onAuthStateChange, hacer `await supabase.from(...)`
 * causa deadlock porque ambos pelean el mismo lock interno.
 * La query de hidratación se difiere con `setTimeout(() => {...}, 0)`
 * para salir del auth lock.
 *
 * Ver docs/DECISIONS.md D-006.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [usuario, setUsuario] = useState<Usuario | null>(null);

  // Atar el usuario a Sentry: cada error reportado lleva id/email de quién lo
  // sufrió (no-op si no hay DSN configurado).
  useEffect(() => {
    setSentryUser(usuario?.id ?? null, usuario?.email ?? undefined);
  }, [usuario]);
  const [isLoading, setIsLoading] = useState(true);

  // Función para hidratar usuario por auth_id
  async function hydrateUsuario(userId: string) {
    const { data, error } = await supabase
      .from('usuarios')
      .select(COLUMNAS_USUARIO_CLIENTE)
      .eq('auth_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[auth] Error hidratando usuario:', error);
      return;
    }

    setUsuario((data as unknown as Usuario | null) ?? null);
  }

  useEffect(() => {
    let mounted = true;
    // 1. Restaurar sesión al mount.
    (async () => {
      const { data: { session: initialSession } } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(initialSession);

      if (initialSession?.user) {
        // Diferir hidratación para no bloquear el primer paint
        setTimeout(() => {
          hydrateUsuario(initialSession.user.id);
          setIsLoading(false);
        }, 0);
      } else {
        setIsLoading(false);
      }
    })();

    // 2. Listener de cambios de auth
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, newSession) => {
        // Sincrónico: actualizar sesión inmediatamente
        setSession(newSession);

        if (event === 'SIGNED_OUT' || !newSession) {
          setUsuario(null);
          return;
        }

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          // CRÍTICO: diferir la query con setTimeout para evitar deadlock
          setTimeout(() => {
            if (newSession.user) {
              hydrateUsuario(newSession.user.id);
            }
          }, 0);
        }
      }
    );

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    setUsuario(null);
    setSession(null);
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        authUser: session?.user ?? null,
        usuario,
        isLoading,
        signOut
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
