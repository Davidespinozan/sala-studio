/**
 * Pantalla de carga del primer paint — se muestra mientras TenantProvider
 * resuelve el tenant (o siempre, en las rutas de marketing de SALA). Antes
 * era un texto plano sin marca; ahora es un anillo animado (primario/acento
 * del tenant si ya se conocen por cache, o el verde default de SALA si no)
 * con el logo en el centro.
 *
 * `logoSrc` es una URL directa (nunca pasa por useTenant()/TenantLogo) porque
 * este componente se renderiza ANTES de que exista el tenant en contexto —
 * usarlo acá tiraría el error de "fuera de TenantProvider". Sin logoSrc se
 * muestra una marca genérica (barras), NUNCA el logo de SALA — eso mezclaría
 * la marca de SALA con la de un tenant que todavía no se conoce.
 */
interface LoadingScreenProps {
  /** URL del isotipo a mostrar en el centro del anillo. Omitir = marca genérica. */
  logoSrc?: string | null;
  /** Texto bajo el anillo. Default 'Cargando…'. */
  label?: string;
}

export function LoadingScreen({ logoSrc, label = 'Cargando…' }: LoadingScreenProps) {
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
