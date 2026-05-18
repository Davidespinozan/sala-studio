import { useSearchParams } from 'react-router-dom';

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
  const [searchParams] = useSearchParams();
  const isDemoMode = searchParams.get('demo') === 'admin-preview';

  if (!isDemoMode) return null;

  const handleVolver = () => {
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
        background: 'var(--ek-mustard)',
        color: 'var(--ek-bg)',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        borderBottom: '0.5px solid var(--ek-mustard-dim)',
        fontWeight: 500,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)'
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
          background: 'rgba(10, 10, 10, 0.1)',
          color: 'var(--ek-bg)',
          border: '0.5px solid rgba(10, 10, 10, 0.3)',
          borderRadius: 'var(--ek-r-sm)',
          padding: '6px 12px',
          fontSize: '12px',
          fontWeight: 700,
          cursor: 'pointer',
          whiteSpace: 'nowrap'
        }}
      >
        Volver al admin →
      </button>
    </div>
  );
}

export default DemoBanner;
