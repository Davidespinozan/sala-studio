import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAdminGuard } from './hooks/useAdminGuard';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { Sidebar } from './components/Sidebar';

const Dashboard = lazy(() => import('./pages/AdminDashboard'));
const Miembros = lazy(() => import('./pages/Miembros'));
const MiembroDetalle = lazy(() => import('./pages/MiembroDetalle'));
const Calendario = lazy(() => import('./pages/Calendario'));
const Recursos = lazy(() => import('./pages/Recursos'));
const Tiers = lazy(() => import('./pages/Tiers'));
const Equipo = lazy(() => import('./pages/Equipo'));
const AjustesLanding = lazy(() => import('./pages/AjustesLanding'));
const AjustesContacto = lazy(() => import('./pages/AjustesContacto'));
const AjustesReglas = lazy(() => import('./pages/AjustesReglas'));
const AjustesMarca = lazy(() => import('./pages/AjustesMarca'));

export default function AdminLayout() {
  const { isLoading } = useAdminGuard();
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (isLoading) return <LoadingScreen />;

  return (
    <div className="adm-shell">
      <div className="adm-sidebar-desktop">
        <Sidebar />
      </div>

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
                zIndex: 2
              }}
            >
              ✕
            </button>
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
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
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '17px',
                fontWeight: 700,
                letterSpacing: '-0.03em',
                color: 'var(--ek-mustard)'
              }}
            >
              EKKO
            </span>
            <span className="ek-eyebrow" style={{ fontSize: '9px' }}>ADMIN</span>
          </div>
          <div style={{ width: '40px' }} />
        </header>

        <main className="adm-main">
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/miembros" element={<Miembros />} />
              <Route path="/miembros/:id" element={<MiembroDetalle />} />
              <Route path="/calendario" element={<Calendario />} />
              <Route path="/recursos" element={<Recursos />} />
              <Route path="/tiers" element={<Tiers />} />
              <Route path="/equipo" element={<Equipo />} />
              <Route path="/landing" element={<AjustesLanding />} />
              <Route path="/contacto" element={<AjustesContacto />} />
              <Route path="/reglas" element={<AjustesReglas />} />
              <Route path="/marca" element={<AjustesMarca />} />
              {/* Legacy redirect: la página plana /admin/configuracion fue
                  reemplazada por las 4 páginas de AJUSTES (Sprint D-Admin). */}
              <Route path="/configuracion" element={<Navigate to="/admin/landing" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
