import { useTenant } from '@shared/hooks/useTenant';
import { TenantLogo } from '@shared/components/TenantLogo';

/** Shell centrado para las pantallas de auth (recuperar / nueva contraseña).
 *  Mismo look que el login: logo del TENANT (isotipo si lo tiene, si no el
 *  wordmark) + card. Nada de "SALA" hardcodeado. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const tenant = useTenant();
  const tieneIsotipo =
    typeof (tenant.branding as Record<string, unknown> | null)?.isotipo_url === 'string';

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 20px'
      }}
    >
      <div style={{ maxWidth: '400px', width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '32px' }}>
          {tieneIsotipo ? (
            <TenantLogo variant="isotipo" height={96} />
          ) : (
            <TenantLogo variant="completo" height={56} fallbackFontSize={38} showSuffix />
          )}
        </div>
        <div className="ek-card">{children}</div>
      </div>
    </div>
  );
}
