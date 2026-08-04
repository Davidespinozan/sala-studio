import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAdminGuard } from './hooks/useAdminGuard';
import { useSuscripcion } from './hooks/useSuscripcion';
import { estadoAccesoSaas, type MotivoBloqueo } from './lib/accesoSaas';
import { SuscripcionBloqueada } from './components/SuscripcionBloqueada';
import { AvisoSuscripcion } from './components/AvisoSuscripcion';
import { useTenant } from '@shared/hooks/useTenant';
import { esTenantDemo } from '@shared/lib/demoAuth';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { AppShell } from '@shared/components/AppShell';
import { TenantGuard } from '@shared/components/TenantGuard';
import { ModoDemoBanner } from '@shared/components/ModoDemoBanner';
import { Sidebar } from './components/Sidebar';
import { CambiarPasswordGate } from '@shared/components/CambiarPasswordGate';
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
const Lectores = lazy(() => import('./pages/Lectores'));
const Reportes = lazy(() => import('./pages/Reportes'));
const Caja = lazy(() => import('./pages/Caja'));
const Tienda = lazy(() => import('./pages/Tienda'));
const Bitacora = lazy(() => import('./pages/Bitacora'));
const Equipo = lazy(() => import('./pages/Equipo'));
const AjustesLanding = lazy(() => import('./pages/AjustesLanding'));
const AjustesContacto = lazy(() => import('./pages/AjustesContacto'));
const AjustesReglas = lazy(() => import('./pages/AjustesReglas'));
const AjustesMarca = lazy(() => import('./pages/AjustesMarca'));
const AjustesNotificaciones = lazy(() => import('./pages/AjustesNotificaciones'));
const Suscripcion = lazy(() => import('./pages/Suscripcion'));
const Cobros = lazy(() => import('./pages/Cobros'));

export default function AdminLayout() {
  const { isLoading } = useAdminGuard();
  const tenant = useTenant();
  const { suscripcion, isLoading: subLoading } = useSuscripcion();

  if (isLoading || subLoading) return <LoadingScreen />;

  // PAYWALL con gracia. El demo se exime; estadoAccesoSaas falla ABIERTO.
  //   'bloqueo' → se reemplaza TODO el panel (ya pasó la gracia).
  //   'aviso'   → sigue operando, con un banner y los días que le quedan.
  // Socios y recepción NO se tocan: esto es solo el panel del dueño.
  const acceso = esTenantDemo(tenant.slug)
    ? { nivel: 'ok' as const, motivo: null, diasParaCorte: null }
    : estadoAccesoSaas(suscripcion);

  if (acceso.nivel === 'bloqueo') {
    return <SuscripcionBloqueada motivo={acceso.motivo as MotivoBloqueo} suscripcion={suscripcion} />;
  }

  return (
    <TenantGuard>
    <ModoDemoBanner />
    <SucursalProvider>
      <AppShell sidebar={({ onNavigate }) => <Sidebar onNavigate={onNavigate} />} roleLabel="ADMIN">
        <CambiarPasswordGate />
        <AvisoSuscripcion acceso={acceso} />
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
              <Route path="/lectores" element={<Lectores />} />
              <Route path="/reportes" element={<Reportes />} />
              <Route path="/caja" element={<Caja />} />
              <Route path="/tienda" element={<Tienda />} />
              <Route path="/bitacora" element={<Bitacora />} />
              <Route path="/equipo" element={<Equipo />} />
              <Route path="/landing" element={<AjustesLanding />} />
              <Route path="/contacto" element={<AjustesContacto />} />
              <Route path="/reglas" element={<AjustesReglas />} />
              <Route path="/marca" element={<AjustesMarca />} />
              <Route path="/notificaciones" element={<AjustesNotificaciones />} />
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
