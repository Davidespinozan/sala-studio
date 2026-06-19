import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { CalendarClock, Users } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { accesoRevocado } from '@shared/lib/accountStatus';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { AppShell } from '@shared/components/AppShell';
import { TenantGuard } from '@shared/components/TenantGuard';
import { ModoDemoBanner } from '@shared/components/ModoDemoBanner';
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
  const { authUser, usuario, isLoading, signOut } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const yaCerrado = useRef(false);

  // Acceso retirado (revocado/suspendido/cancelado) → toast + signOut. Igual que
  // MemberLayout: no navegamos a /login mientras `usuario` sigue en cache (haría
  // loop con useRoleRedirect); mostramos loading hasta que el signOut limpie la
  // sesión y caigamos en el Navigate a /login de abajo.
  useEffect(() => {
    if (isLoading || !authUser || !usuario) return;
    if (!accesoRevocado(usuario.status)) return;
    if (yaCerrado.current) return;
    yaCerrado.current = true;
    toast.error('Tu acceso fue revocado. Contacta al administrador.', 8000);
    void signOut();
  }, [authUser, usuario, isLoading, signOut, toast]);

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!usuario) return <LoadingScreen />;
  if (accesoRevocado(usuario.status)) return <LoadingScreen />;

  if (usuario.rol !== 'recepcionista' && usuario.rol !== 'admin') {
    return <Navigate to="/app" replace />;
  }

  return (
    <TenantGuard>
      <ModoDemoBanner />
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
    </TenantGuard>
  );
}
