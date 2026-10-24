import { useTenant } from '@shared/hooks/useTenant';

/**
 * Pantalla de carga del primer paint — se muestra mientras TenantProvider
 * resuelve el tenant (o siempre, en las rutas de marketing de SALA). Antes
 * era un texto plano sin marca; ahora es un anillo animado (primario/acento
 * del tenant si ya se conocen por cache, o el verde default de SALA si no)
 * con una marca en el centro, en cascada:
 *   1. logoSrc (isotipo real, si ya se cacheó)
 *   2. inicial (letra del nombre del tenant, con sus colores) — MUCHOS
 *      tenants nunca suben un isotipo cuadrado (solo el logo horizontal, un
 *      campo aparte en Ajustes > Marca — ver TenantLogo.tsx), así que esto
 *      es el caso común, no el raro.
 *   3. marca genérica (barras) — solo en la primera visita, cuando todavía
 *      no se conoce NADA del tenant (ni color ni nombre).
 *
 * `logoSrc`/`inicial` son datos directos (nunca pasan por useTenant()/
 * TenantLogo) porque este componente se renderiza ANTES de que exista el
 * tenant en contexto — usarlo acá tiraría el error de "fuera de
 * TenantProvider". Nunca cae al logo de SALA — eso mezclaría la marca de
 * SALA con la de un tenant que todavía no se conoce del todo.
 */
interface LoadingScreenProps {
  /** URL del isotipo a mostrar en el centro del anillo. */
  logoSrc?: string | null;
  /** Inicial del nombre del tenant, para cuando no hay isotipo cacheado. */
  inicial?: string | null;
  /** Texto bajo el anillo. Default 'Cargando…'. */
  label?: string;
}

export function LoadingScreen({ logoSrc, inicial, label = 'Cargando…' }: LoadingScreenProps) {
  return (
    <div className="sala-loader" role="status" aria-live="polite" aria-label={label}>
      <div className="ek-orb" style={{ width: '260px', height: '260px', top: '-8%', left: '-10%' }} />
      <div
        className="ek-orb"
        style={{ width: '300px', height: '300px', bottom: '-12%', right: '-8%', animationDelay: '-9s' }}
      />
      <div className="sala-loader-mark">
        <div className="sala-loader-ring" />
        {logoSrc ? (
          <img className="sala-loader-logo" src={logoSrc} alt="" />
        ) : inicial ? (
          <div className="sala-loader-badge" aria-hidden>
            {inicial}
          </div>
        ) : (
          <div className="sala-loader-glyph">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      <p className="sala-loader-label">{label}</p>
    </div>
  );
}

/**
 * Variante para usar DENTRO del árbol de TenantProvider, donde el tenant real
 * ya existe en contexto (Suspense de rutas, guards de auth en los layouts de
 * admin/socio/recepción/público). A diferencia de LoadingScreen —que corre
 * ANTES de que exista el tenant y por eso depende del cache de localStorage—
 * acá usamos el isotipo real sin caché: no puede desactualizarse ni faltar.
 * Misma cascada que TenantLogo variant='isotipo' (isotipo_url → inicial).
 */
export function TenantLoadingScreen({ label }: { label?: string }) {
  const tenant = useTenant();
  const branding = (tenant.branding ?? {}) as Record<string, unknown>;
  const logoSrc = typeof branding.isotipo_url === 'string' ? branding.isotipo_url : null;
  const nombre = tenant.nombre?.trim();
  const inicial = !logoSrc && nombre ? nombre[0].toUpperCase() : null;
  return <LoadingScreen logoSrc={logoSrc} inicial={inicial} label={label} />;
}
