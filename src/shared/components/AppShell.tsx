import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { TenantLogo } from '@shared/components/TenantLogo';
import NotificacionesBell from '@shared/components/NotificacionesBell';
import { ErrorBoundary } from '@shared/components/ErrorBoundary';

/**
 * Shell de layout con sidebar oscuro (admin + recepción): columna sidebar en
 * desktop, drawer hamburguesa en mobile, topbar mobile, y el área de contenido.
 * Mismo markup/clases (.adm-shell, .adm-drawer, .adm-content, .adm-topbar-mobile)
 * que el AdminLayout original — admin queda idéntico.
 *
 * `sidebar` es un render-prop para poder pasarle onNavigate al drawer (cierra
 * el drawer al navegar) sin duplicar el sidebar.
 */
export function AppShell({
  sidebar,
  roleLabel,
  children
}: {
  sidebar: (opts: { onNavigate?: () => void }) => ReactNode;
  roleLabel: string;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="adm-shell">
      <div className="adm-sidebar-desktop">{sidebar({})}</div>

      {drawerOpen && (
        <div className="adm-drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <div className="adm-drawer" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setDrawerOpen(false)}
              aria-label="Cerrar menú"
              className="ek-icon-btn"
              style={{
                position: 'absolute',
                top: '16px',
                right: '16px',
                width: '36px',
                height: '36px',
                padding: 0,
                zIndex: 2,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <X size={18} strokeWidth={2.25} />
            </button>
            {sidebar({ onNavigate: () => setDrawerOpen(false) })}
          </div>
        </div>
      )}

      <div className="adm-content">
        <header className="adm-topbar-mobile">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Abrir menú"
            className="ek-icon-btn"
            style={{ width: '40px', height: '40px', padding: 0 }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <TenantLogo variant="completo" height={34} fallbackFontSize={28} showSuffix={false} />
            <span className="ek-eyebrow" style={{ fontSize: '9px' }}>{roleLabel}</span>
          </div>
          <NotificacionesBell tone="dark" />
        </header>

        {/* Desktop: no hay topbar; la campana vive en una barra propia arriba. */}
        <div className="adm-topbar-desktop">
          <NotificacionesBell tone="light" />
        </div>

        {/* Un error en una página NO tumba todo el panel: el shell sobrevive y
            se puede reintentar o navegar a otra sección. */}
        <ErrorBoundary variant="inline" resetKeys={[location.pathname]}>
          {children}
        </ErrorBoundary>
      </div>
    </div>
  );
}
