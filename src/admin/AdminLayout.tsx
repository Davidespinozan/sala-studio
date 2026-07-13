import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAdminGuard } from './hooks/useAdminGuard';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { AppShell } from '@shared/components/AppShell';
import { TenantGuard } from '@shared/components/TenantGuard';
import { ModoDemoBanner } from '@shared/components/ModoDemoBanner';
import { Sidebar } from './components/Sidebar';
import { SucursalProvider } from './providers/SucursalProvider';
import { SucursalSelectorBar } from './components/SucursalSelectorBar';

const Dashboard = lazy(() => import('./pages/AdminDashboard'));
const Miembros = lazy(() => import('./pages/Miembros'));
const MiembroDetalle = lazy(() => import('./pages/MiembroDetalle'));
const Calendario = lazy(() => import('./pages/Calendario'));
const Agenda = lazy(() => import('./pages/Agenda'));
const Recursos = lazy(() => import('./pages/Recursos'));
const Horarios = lazy(() => import('./pages/Horarios'));
const Instructores = lazy(() => import('./pages/Instructores'));
const Tiers = lazy(() => import('./pages/Tiers'));
const Sucursales = lazy(() => import('./pages/Sucursales'));
const Reportes = lazy(() => import('./pages/Reportes'));
const Caja = lazy(() => import('./pages/Caja'));
const Bitacora = lazy(() => import('./pages/Bitacora'));
const Equipo = lazy(() => import('./pages/Equipo'));
const AjustesLanding = lazy(() => import('./pages/AjustesLanding'));
const AjustesContacto = lazy(() => import('./pages/AjustesContacto'));
const AjustesReglas = lazy(() => import('./pages/AjustesReglas'));
const AjustesMarca = lazy(() => import('./pages/AjustesMarca'));
const Suscripcion = lazy(() => import('./pages/Suscripcion'));
const Cobros = lazy(() => import('./pages/Cobros'));

export default function AdminLayout() {
  const { isLoading } = useAdminGuard();

  if (isLoading) return <LoadingScreen />;

  return (
    <TenantGuard>
    <ModoDemoBanner />
    <SucursalProvider>
      <AppShell sidebar={({ onNavigate }) => <Sidebar onNavigate={onNavigate} />} roleLabel="ADMIN">
        <SucursalSelectorBar />

        <main className="adm-main">
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/miembros" element={<Miembros />} />
              <Route path="/miembros/:id" element={<MiembroDetalle />} />
              <Route path="/calendario" element={<Calendario />} />
              <Route path="/agenda" element={<Agenda />} />
              <Route path="/recursos" element={<Recursos />} />
              <Route path="/horarios" element={<Horarios />} />
              <Route path="/instructores" element={<Instructores />} />
              <Route path="/tiers" element={<Tiers />} />
              <Route path="/sucursales" element={<Sucursales />} />
              <Route path="/reportes" element={<Reportes />} />
              <Route path="/caja" element={<Caja />} />
              <Route path="/bitacora" element={<Bitacora />} />
              <Route path="/equipo" element={<Equipo />} />
              <Route path="/landing" element={<AjustesLanding />} />
              <Route path="/contacto" element={<AjustesContacto />} />
              <Route path="/reglas" element={<AjustesReglas />} />
              <Route path="/marca" element={<AjustesMarca />} />
              <Route path="/suscripcion" element={<Suscripcion />} />
              <Route path="/cobros" element={<Cobros />} />
              {/* Legacy redirect: la página plana /admin/configuracion fue
                  reemplazada por las 4 páginas de AJUSTES (Sprint D-Admin). */}
              <Route path="/configuracion" element={<Navigate to="/admin/landing" replace />} />
            </Routes>
          </Suspense>
        </main>
      </AppShell>
    </SucursalProvider>
    </TenantGuard>
  );
}
