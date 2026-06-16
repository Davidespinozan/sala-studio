import { ArrowRight } from 'lucide-react';
import { useAdminPreview } from '@shared/hooks/useAdminPreview';
import { exitAdminPreview } from '@shared/lib/adminPreview';
import { useAuth } from '@shared/hooks/useAuth';
import { esSesionDemo } from '@shared/lib/demoAuth';

export type DemoVista = 'Landing' | 'Miembro' | 'Recepción';

interface DemoBannerProps {
  vista: DemoVista;
}

/**
 * Banner sticky top que se renderiza SOLO si la URL tiene `?demo=admin-preview`.
 * Visible en vistas accedidas via "VER COMO…" del admin (Sprint D-Polish).
 *
 * Click "Volver al admin" intenta cerrar la pestaña (si fue abierta por
 * window.open). Si window.close() falla — porque el navegador no permite
 * cerrar pestañas no abiertas por script — cae a redirect a /admin/landing.
 */
export function DemoBanner({ vista }: DemoBannerProps) {
  const isDemoMode = useAdminPreview();
  const { authUser } = useAuth();

  // En una sesión del demo público (usuario anónimo) ya está el banner "Modo
  // demo"; este "Ver como…" del admin sobra y confunde → no se muestra.
  if (esSesionDemo(authUser)) return null;
  if (!isDemoMode) return null;

  const handleVolver = () => {
    // Limpia el latch pegajoso (si no, el modo preview seguiría activo en la pestaña).
    exitAdminPreview();
    // Intentar cerrar la pestaña primero
    window.close();
    // Si todavía estamos acá tras un beat, redirigir como fallback
    setTimeout(() => {
      window.location.href = '/admin/landing';
    }, 100);
  };

  return (
    <div
      role="banner"
      aria-label="Vista de demostración"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 80,
        background: 'var(--sala-primary)',
        color: 'var(--sala-text-on-primary)',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        borderBottom: '0.5px solid var(--sala-primary-hover)',
        fontWeight: 500
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        <span aria-hidden="true">🔍</span>
        <span style={{ fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Vista de demostración · Estás viendo como <strong>{vista}</strong>
        </span>
      </div>
      <button
        type="button"
        onClick={handleVolver}
        style={{
          background: 'rgba(255, 255, 255, 0.18)',
          color: 'var(--sala-text-on-primary)',
          border: '0.5px solid rgba(255, 255, 255, 0.4)',
          borderRadius: 'var(--ek-r-sm)',
          padding: '6px 12px',
          fontSize: '12px',
          fontWeight: 700,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px'
        }}
      >
        Volver al admin
        <ArrowRight size={14} strokeWidth={2.25} />
      </button>
    </div>
  );
}

export default DemoBanner;
