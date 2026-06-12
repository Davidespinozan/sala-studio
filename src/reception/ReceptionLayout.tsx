import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { CalendarClock, Users } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { AppShell } from '@shared/components/AppShell';
import { AppSidebar, type AppNavSection } from '@shared/components/AppSidebar';

const Scanner = lazy(() => import('./pages/Scanner'));
const Socios = lazy(() => import('./pages/Socios'));
const SocioFicha = lazy(() => import('./pages/SocioFicha'));

// Nav de RECEPCIÓN — plana (sin secciones colapsables), 2 destinos.
const RECEPCION_SECTIONS: AppNavSection[] = [
  {
    items: [
      { to: '/recepcion', label: 'Hoy', icon: <CalendarClock size={18} /> },
      { to: '/recepcion/socios', label: 'Socios', icon: <Users size={18} /> }
    ]
  }
];

export default function ReceptionLayout() {
  const { authUser, usuario, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!usuario) return <LoadingScreen />;

  if (usuario.rol !== 'recepcionista' && usuario.rol !== 'admin') {
    return <Navigate to="/app" replace />;
  }

  return (
    <>
      <DemoBanner vista="Recepción" />
      <AppShell
        roleLabel="RECEPCIÓN"
        sidebar={({ onNavigate }) => (
          <AppSidebar
            sections={RECEPCION_SECTIONS}
            roleLabel="RECEPCIÓN"
            homePath="/recepcion"
            onNavigate={onNavigate}
          />
        )}
      >
        <main className="adm-main">
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route path="/" element={<Scanner />} />
              <Route path="/socios" element={<Socios />} />
              <Route path="/socios/:id" element={<SocioFicha />} />
            </Routes>
          </Suspense>
        </main>
      </AppShell>
    </>
  );
}
