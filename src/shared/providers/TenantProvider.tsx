import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';
import { LoadingScreen } from '@shared/components/LoadingScreen';

type Tenant = Database['public']['Tables']['tenants']['Row'];

interface TenantContextValue {
  tenant: Tenant | null;
  isLoading: boolean;
  error: Error | null;
}

const TenantContext = createContext<TenantContextValue>({
  tenant: null,
  isLoading: true,
  error: null
});

/**
 * Resuelve el tenant actual y lo expone vía context.
 *
 * Estrategia de resolución (en orden):
 * 1. Subdominio: app.ekko.studio → slug 'ekko'
 *                pilates-noria.sala.app → slug 'pilates-noria'
 * 2. Fallback en desarrollo: slug 'ekko' (siempre el primer tenant)
 *
 * Para SaaS multi-tenant en producción, el subdominio decide.
 */
function resolveTenantSlug(): string {
  if (typeof window === 'undefined') return 'ekko';

  const host = window.location.hostname;

  // localhost / 127.0.0.1 / preview deploys → default ekko
  if (host === 'localhost' || host.startsWith('127.') || host.endsWith('.netlify.app')) {
    return 'ekko';
  }

  // app.ekko.studio → ekko
  // pilates-noria.sala.app → pilates-noria
  const parts = host.split('.');
  if (parts.length >= 2) {
    return parts[0] === 'app' && parts.length >= 3 ? parts[1] : parts[0];
  }

  return 'ekko';
}

interface TenantProviderProps {
  children: ReactNode;
}

export function TenantProvider({ children }: TenantProviderProps) {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadTenant() {
      try {
        const slug = resolveTenantSlug();
        const { data, error: queryError } = await supabase
          .from('tenants')
          .select('*')
          .eq('slug', slug)
          .eq('status', 'activo')
          .maybeSingle();

        if (!isMounted) return;

        if (queryError) {
          setError(new Error(`No se pudo cargar el tenant: ${queryError.message}`));
          setIsLoading(false);
          return;
        }

        if (!data) {
          setError(new Error(`Tenant '${slug}' no encontrado o inactivo`));
          setIsLoading(false);
          return;
        }

        setTenant(data);
        setIsLoading(false);

        // Branding tokens dinámicos están desactivados en Sprint C1.
        // EKKO usa paleta fija "Mostaza Ink" definida en CSS global.
        //
        // Para activar multi-paleta dinámica en Sprint D:
        // 1. Mapear branding.color_primary → --ek-mustard
        // 2. Mapear branding.color_bg → --ek-bg
        // 3. Mapear branding.color_accent → --ek-mustard-soft
        // 4. Auditar todos los usos de hex codes hardcoded en componentes
        // 5. Documentar el contrato en KERNEL.md sección "Branding"
        //
        // branding sigue disponible en el contexto para Sprint D:
        // logo_url, og_image_url, favicon_url (cuando se implementen).

        // Setear título dinámico
        if (data.nombre) {
          document.title = data.nombre;
        }
      } catch (err) {
        if (!isMounted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      }
    }

    loadTenant();

    return () => {
      isMounted = false;
    };
  }, []);

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (error || !tenant) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          background: 'var(--ek-cream)',
          color: 'var(--ek-black)',
          textAlign: 'center'
        }}
      >
        <div>
          <p style={{ fontSize: '0.75rem', letterSpacing: '0.16em', color: 'var(--ek-danger)', marginBottom: '0.5rem' }}>
            ERROR
          </p>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            No se pudo cargar la configuración
          </h1>
          <p style={{ color: 'var(--ek-ink-muted)', maxWidth: '32rem' }}>
            {error?.message ?? 'Tenant no disponible'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <TenantContext.Provider value={{ tenant, isLoading: false, error: null }}>
      {children}
    </TenantContext.Provider>
  );
}

export function useTenant(): Tenant {
  const { tenant } = useContext(TenantContext);
  if (!tenant) {
    throw new Error('useTenant() llamado fuera de <TenantProvider>');
  }
  return tenant;
}
