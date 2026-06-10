import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import NotificacionesBanner from './components/NotificacionesBanner';
import EstadoMembresiaBanner from './components/EstadoMembresiaBanner';
import { BottomNav } from './components/BottomNav';
import { TenantLogo } from '@shared/components/TenantLogo';
import { PoweredBySala } from '@shared/components/PoweredBySala';
import { PwaInstallBanner } from '@shared/components/PwaInstallBanner';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Reservar = lazy(() => import('./pages/Reservar'));
const Historial = lazy(() => import('./pages/Historial'));
const Perfil = lazy(() => import('./pages/Perfil'));
const MiQR = lazy(() => import('./pages/MiQR'));
const Estudios = lazy(() => import('./pages/Estudios'));
const EstudioDetalle = lazy(() => import('./pages/EstudioDetalle'));
const ClaseDetalle = lazy(() => import('./pages/ClaseDetalle'));

function mensajeStatus(status: string): string {
  if (status === 'suspendido')
    return 'Tu cuenta fue suspendida. Contactá al administrador para más información.';
  if (status === 'cancelado') return 'Tu cuenta fue cancelada.';
  if (status === 'pendiente_onboarding')
    return 'Tu cuenta aún no completa el onboarding. Contactá al administrador.';
  if (status === 'pendiente_pago')
    return 'Tu cuenta está pendiente de pago. Contactá al administrador.';
  return 'Tu cuenta no está activa. Contactá al administrador.';
}

export default function MemberLayout() {
  const { authUser, usuario, isLoading, signOut } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const yaCerrado = useRef(false);

  useEffect(() => {
    if (isLoading) return;
    if (!authUser || !usuario) return;
    if (usuario.status === 'activo') return;
    if (yaCerrado.current) return;
    yaCerrado.current = true;

    toast.error(mensajeStatus(usuario.status), 8000);
    // signOut limpia la sesión; el Navigate de abajo redirige a /login
    void signOut();
  }, [authUser, usuario, isLoading, signOut, toast]);

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;
  if (usuario && usuario.status !== 'activo') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <div className="ek-page" style={{ paddingBottom: '88px' /* espacio para bottom nav */ }}>
      <DemoBanner vista="Miembro" />
      <NotificacionesBanner />
      <EstadoMembresiaBanner />
      <header className="ek-header-glass">
        <div className="ek-header-inner" style={{ justifyContent: 'center' }}>
          <Link to="/app" style={{ textDecoration: 'none', display: 'inline-block' }}>
            <TenantLogo variant="completo" height={48} fallbackFontSize={34} showSuffix={true} />
          </Link>
        </div>
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/reservar" element={<Reservar />} />
          <Route path="/estudios" element={<Estudios />} />
          <Route path="/estudios/:slug" element={<EstudioDetalle />} />
          <Route path="/clase/:id" element={<ClaseDetalle />} />
          <Route path="/historial" element={<Historial />} />
          <Route path="/perfil" element={<Perfil />} />
          <Route path="/qr/:reservaId" element={<MiQR />} />
        </Routes>
      </Suspense>

      <PoweredBySala />

      <BottomNav />
      <PwaInstallBanner />
    </div>
  );
}
