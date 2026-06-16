import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { getFont, getScaleValue, buildFontsHref } from '@shared/lib/fonts';

type Tenant = Database['public']['Tables']['tenants']['Row'];

interface TenantContextValue {
  tenant: Tenant | null;
  isLoading: boolean;
  error: Error | null;
  /** Re-lee el tenant desde la DB y re-aplica branding (colores + logo). */
  refetch: () => Promise<void>;
}

// ============================================================================
// Helpers de color — Fase A del sistema dinámico (D-017 RESUELTO)
// ============================================================================
// Estos 4 helpers + applyBranding/restoreBranding deciden los 4 flags
// JS-decididos del contrato CSS (--sala-primary, --sala-primary-text,
// --sala-primary-tint y los equivalentes accent). Los 20 derivados se
// recalculan solos vía color-mix() en sala.css.
//
// Umbrales (validados en scripts/validate-color-regression.mjs):
//   - pickTextOn:    L > 0.55  → texto negro; sino texto blanco. WCAG AA UI.
//   - pickHoverTint: L < 0.06  → lighten (white); sino darken (black).
//     SALA verde tiene L=0.121 → darken (consistente con --sala-primary-hover
//     hand-tuned original #2F5440).

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(cleaned)) return null;
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16)
  };
}

export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const linearize = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

export function pickTextOn(hex: string): string {
  return relativeLuminance(hex) > 0.55 ? '#0A0A0A' : '#FFFFFF';
}

export function pickHoverTint(hex: string): '#000000' | '#FFFFFF' {
  return relativeLuminance(hex) < 0.06 ? '#FFFFFF' : '#000000';
}

/** Contrast ratio WCAG entre dos hex. >=4.5 pasa AA texto, >=3 pasa AA UI. */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

interface BrandingColors {
  color_primary?: string | null;
  color_accent?: string | null;
  /** Tipografía de marca (claves de shared/lib/fonts) + escala de tamaño. */
  font_display?: string | null;
  font_body?: string | null;
  font_scale?: string | null;
}

/**
 * Pisa los 6 flags dinámicos del :root con los colores del tenant.
 * Los 20 derivados se recalculan solos vía color-mix().
 * Si algún color es inválido, no pisa nada (queda el default SALA).
 */
export function applyBranding(branding: BrandingColors | null | undefined): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const primary = (branding?.color_primary as string | undefined) || '#3D6B52';
  // Sin accent explícito → acento = primary (paleta monocromática). Un tenant
  // puede setear su propio color_accent para volver a un esquema de 2 colores.
  const accent = (branding?.color_accent as string | undefined) || primary;

  if (!hexToRgb(primary) || !hexToRgb(accent)) {
    // Datos inválidos en DB — preserva defaults del :root.
    return;
  }

  root.style.setProperty('--sala-primary', primary);
  root.style.setProperty('--sala-primary-text', pickTextOn(primary));
  root.style.setProperty('--sala-primary-tint', pickHoverTint(primary));

  root.style.setProperty('--sala-accent', accent);
  root.style.setProperty('--sala-accent-text', pickTextOn(accent));
  root.style.setProperty('--sala-accent-tint', pickHoverTint(accent));

  // D-021 (dos capas de color): los tokens SEMÁNTICOS (--sala-warning/-error y
  // derivados) son FIJOS del sistema (ámbar/coral/verde) — NO se remapean a la
  // marca del tenant. Antes acá se forzaban a primario/acento (monocromo); eso
  // contradecía D-021 y se quitó. Quedan en sus valores del :root para todos.
}

/**
 * Aplica el branding del tenant al <head>: favicon (= isotipo, o favicon_url si
 * lo definió), apple-touch-icon, y meta OG/Twitter (título + imagen social).
 * Así el isotipo aparece en la pestaña del navegador, al instalar la PWA, y al
 * compartir el link en redes — no solo dentro de la app.
 */
function applyTenantHead(branding: BrandingColors | null | undefined, nombre: string | null): void {
  if (typeof document === 'undefined') return;
  const b = (branding ?? {}) as Record<string, unknown>;
  const favicon =
    (typeof b.favicon_url === 'string' && b.favicon_url) ||
    (typeof b.isotipo_url === 'string' && b.isotipo_url) ||
    null;

  if (favicon) {
    document.head
      .querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')
      .forEach((el) => el.remove());
    (['icon', 'apple-touch-icon'] as const).forEach((rel) => {
      const link = document.createElement('link');
      link.setAttribute('rel', rel);
      link.setAttribute('href', favicon);
      document.head.appendChild(link);
    });
  }

  const setMeta = (attr: 'property' | 'name', key: string, content: string) => {
    let el = document.head.querySelector(`meta[${attr}="${key}"]`);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.setAttribute('content', content);
  };

  if (nombre) {
    setMeta('property', 'og:title', nombre);
    setMeta('name', 'twitter:title', nombre);
  }
  const og = typeof b.og_image_url === 'string' ? b.og_image_url : null;
  if (og) {
    setMeta('property', 'og:image', og);
    setMeta('name', 'twitter:image', og);
    setMeta('name', 'twitter:card', 'summary_large_image');
  }

  // PWA: manifest dinámico. Sin esto, "Agregar a pantalla de inicio" sugiere el
  // nombre/ícono de SALA (manifest estático del build). Generamos uno en runtime
  // con el NOMBRE, el ícono (isotipo) y los colores del tenant, vía blob URL.
  if (typeof window !== 'undefined' && (nombre || favicon)) {
    const origin = window.location.origin;
    const primary = typeof b.color_primary === 'string' ? b.color_primary : '#3D6B52';
    const bgColor = typeof b.color_bg === 'string' ? b.color_bg : '#F5F1E8';
    const isotipo = typeof b.isotipo_url === 'string' ? b.isotipo_url : favicon;
    const esSvg = !!isotipo && isotipo.toLowerCase().endsWith('.svg');
    const iconType = esSvg ? 'image/svg+xml' : 'image/png';
    const nombreApp = nombre || 'Studio';
    // Un SVG con sizes fijos (192/512) Chrome lo IGNORA para instalar → una sola
    // entrada sizes:'any'. PNG sí usa los tamaños fijos + maskable.
    const icons = !isotipo
      ? []
      : esSvg
        ? [{ src: isotipo, sizes: 'any', type: iconType, purpose: 'any' }]
        : [
            { src: isotipo, sizes: '192x192', type: iconType, purpose: 'any' },
            { src: isotipo, sizes: '512x512', type: iconType, purpose: 'any' },
            { src: isotipo, sizes: 'any', type: iconType, purpose: 'maskable' }
          ];
    const manifest = {
      name: nombreApp,
      short_name: nombreApp.slice(0, 18),
      start_url: `${origin}/`,
      scope: `${origin}/`,
      display: 'standalone',
      background_color: bgColor,
      theme_color: primary,
      icons
    };
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    const url = URL.createObjectURL(blob);
    let link = document.head.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    // Revoca el blob anterior que generamos (evita fuga de memoria entre refetch).
    if (link.dataset.dynamic === 'true' && link.href.startsWith('blob:')) {
      URL.revokeObjectURL(link.href);
    }
    link.href = url;
    link.dataset.dynamic = 'true';
    setMeta('name', 'theme-color', primary);
  }
}

/**
 * Aplica la TIPOGRAFÍA del tenant: pisa --ek-font-display / --ek-font-body con
 * las fuentes elegidas (curadas, ver shared/lib/fonts), inyecta el <link> de
 * Google Fonts, y setea --sala-font-scale (escala global de tamaño). Si el
 * tenant no eligió fuente, se quita el override → vuelve al default del :root.
 */
export function applyTypography(branding: BrandingColors | null | undefined): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const b = (branding ?? {}) as Record<string, unknown>;
  const display = getFont(typeof b.font_display === 'string' ? b.font_display : null);
  const body = getFont(typeof b.font_body === 'string' ? b.font_body : null);
  const scale = getScaleValue(typeof b.font_scale === 'string' ? b.font_scale : null);

  if (display) root.style.setProperty('--ek-font-display', display.stack);
  else root.style.removeProperty('--ek-font-display');

  if (body) {
    root.style.setProperty('--ek-font-body', body.stack);
    root.style.setProperty('--ek-font-sans', body.stack);
  } else {
    root.style.removeProperty('--ek-font-body');
    root.style.removeProperty('--ek-font-sans');
  }

  root.style.setProperty('--sala-font-scale', String(scale));

  const href = buildFontsHref([display?.google, body?.google]);
  let link = document.getElementById('tenant-fonts') as HTMLLinkElement | null;
  if (href) {
    if (!link) {
      link = document.createElement('link');
      link.id = 'tenant-fonts';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.href !== href) link.href = href;
  } else if (link) {
    link.remove();
  }
}

/**
 * Revierte el applyBranding — borra los overrides inline para volver al
 * valor declarado en el :root. Usado por AjustesMarca al cancelar el
 * preview en tiempo real (vuelve al estado persistido).
 */
export function restoreBranding(branding: BrandingColors | null | undefined): void {
  // Re-aplica con el branding persistido (NO borra los style props porque
  // siempre queremos los flags JS-decididos seteados al valor "correcto"
  // para el branding actual, no al SALA default).
  applyBranding(branding);
}

const TenantContext = createContext<TenantContextValue>({
  tenant: null,
  isLoading: true,
  error: null,
  refetch: async () => {}
});

/**
 * Resuelve el tenant actual y lo expone vía context.
 *
 * Estrategia de resolución (en orden):
 * 1. Subdominio: app.sala.studio → slug 'healthyspace'
 *                pilates-noria.sala.app → slug 'pilates-noria'
 * 2. Fallback en desarrollo: slug 'healthyspace' (el tenant demo)
 *
 * Para SaaS multi-tenant en producción, el subdominio decide.
 */
/**
 * Hosts de MARKETING (producto SALA), no de un tenant. En la raíz se muestra
 * la landing de SALA (/para-gimnasios → onboarding), no la página de un gym.
 * Extendé esta lista si agregás otro dominio raíz.
 */
const MARKETING_HOSTS = new Set([
  'salastudio.app',
  'www.salastudio.app'
]);

/** Apex canónico de marketing. Las URLs de gyms nuevos se arman como
 *  {slug}.{MARKETING_DOMAIN} en producción (no contra window.location.host, que
 *  anidaría subdominios). */
export const MARKETING_DOMAIN = 'salastudio.app';

/** true si estamos en el dominio raíz de SALA (no en un subdominio de tenant). */
export function isMarketingRoot(): boolean {
  if (typeof window === 'undefined') return false;
  return MARKETING_HOSTS.has(window.location.hostname);
}

/**
 * true si el slug del tenant viene de un SUBDOMINIO autoritativo (producción),
 * no de un FALLBACK de desarrollo/preview (localhost / 127.* / *.netlify.app) ni
 * del dominio de marketing.
 *
 * En los fallbacks el tenant cargado es 'healthyspace' POR DEFECTO — no identifica
 * al gimnasio del usuario. Por eso el TenantGuard solo debe bloquear el cruce de
 * tenants cuando el subdominio ES autoritativo; si no, ninguna cuenta real podría
 * entrar en local/preview (los datos igual los aísla RLS por el tenant del
 * usuario, no por este objeto de branding).
 */
export function isTenantFromSubdomain(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (MARKETING_HOSTS.has(host)) return false;
  if (host === 'localhost' || host.startsWith('127.') || host.endsWith('.netlify.app')) {
    return false;
  }
  // Necesita al menos un subdominio real (pilates-noria.sala.app, app.sala.studio…).
  return host.split('.').length >= 2;
}

function resolveTenantSlug(): string {
  if (typeof window === 'undefined') return 'healthyspace';

  const host = window.location.hostname;

  // Dominio raíz de marketing → carga healthyspace (el tenant demo; provee un
  // contexto real para el apex; el routing decide mostrar SalaLanding en "/").
  if (MARKETING_HOSTS.has(host)) {
    return 'healthyspace';
  }

  // localhost / 127.0.0.1 / preview deploys → default healthyspace
  if (host === 'localhost' || host.startsWith('127.') || host.endsWith('.netlify.app')) {
    return 'healthyspace';
  }

  // app.sala.studio → healthyspace
  // pilates-noria.sala.app → pilates-noria
  const parts = host.split('.');
  if (parts.length >= 2) {
    return parts[0] === 'app' && parts.length >= 3 ? parts[1] : parts[0];
  }

  return 'healthyspace';
}

interface TenantProviderProps {
  children: ReactNode;
}

export function TenantProvider({ children }: TenantProviderProps) {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  /**
   * Aplica un tenant cargado al estado + branding (colores y, vía el objeto
   * tenant, el logo que renderiza TenantLogo). Reutilizable por carga inicial
   * y por refetch (ej. después de guardar la marca en /admin/ajustes/marca).
   */
  const aplicarTenant = useCallback((data: Tenant) => {
    setTenant(data);
    // En el host de MARKETING (apex salastudio.app) el tenant cargado es solo un
    // FALLBACK (hoy healthyspace) para tener contexto — NO su marca. La marca SALA
    // es fija (.sala-brand + el <head> estático de index.html). Si aplicáramos el
    // branding del fallback, el apex adquiriría sus colores, fuente, título,
    // favicon y theme-color del navegador. Por eso, en marketing root no tocamos
    // nada visual: dejamos los defaults de SALA.
    if (isMarketingRoot()) return;

    // D-017 RESUELTO: aplicar color dinámico del tenant al :root.
    // Pisa --sala-primary/-text/-tint y --sala-accent/-text/-tint; los 20
    // derivados se recalculan vía color-mix() en sala.css.
    applyBranding(data.branding as BrandingColors | null);
    if (data.nombre) document.title = data.nombre;
    // Favicon (= isotipo), apple-touch-icon y meta OG/Twitter desde el branding:
    // el isotipo del tenant aparece en la pestaña, en la PWA y al compartir el link.
    applyTenantHead(data.branding as BrandingColors | null, data.nombre ?? null);
    applyTypography(data.branding as BrandingColors | null);
  }, []);

  const fetchTenant = useCallback(async (): Promise<Tenant> => {
    const slug = resolveTenantSlug();
    const { data, error: queryError } = await supabase
      .from('tenants')
      .select('*')
      .eq('slug', slug)
      .eq('status', 'activo')
      .maybeSingle();
    if (queryError) throw new Error(`No se pudo cargar el tenant: ${queryError.message}`);
    if (!data) throw new Error(`Tenant '${slug}' no encontrado o inactivo`);
    return data;
  }, []);

  /** Re-lee el tenant y re-aplica branding. No rompe la pantalla si falla. */
  const refetch = useCallback(async () => {
    try {
      aplicarTenant(await fetchTenant());
    } catch (err) {
      console.error('[tenant] refetch error:', err);
    }
  }, [aplicarTenant, fetchTenant]);

  useEffect(() => {
    let isMounted = true;
    fetchTenant()
      .then((data) => {
        if (!isMounted) return;
        aplicarTenant(data);
        setIsLoading(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [fetchTenant, aplicarTenant]);

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
    <TenantContext.Provider value={{ tenant, isLoading: false, error: null, refetch }}>
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

/** Devuelve la función para re-leer el tenant (colores + logo) tras un cambio. */
export function useTenantRefetch(): () => Promise<void> {
  return useContext(TenantContext).refetch;
}
