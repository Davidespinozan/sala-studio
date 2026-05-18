import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import NotificacionesBanner from './components/NotificacionesBanner';
import { BottomNav } from './components/BottomNav';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Reservar = lazy(() => import('./pages/Reservar'));
const Historial = lazy(() => import('./pages/Historial'));
const Perfil = lazy(() => import('./pages/Perfil'));
const MiQR = lazy(() => import('./pages/MiQR'));
const Estudios = lazy(() => import('./pages/Estudios'));
const EstudioDetalle = lazy(() => import('./pages/EstudioDetalle'));

function mensajeStatus(status: string): string {
  if (status === 'suspendido')
    return 'Tu cuenta ha sido suspendida. Contacta al administrador para más información.';
  if (status === 'cancelado') return 'Tu cuenta ha sido cancelada.';
  if (status === 'pendiente_onboarding')
    return 'Tu cuenta aún no completa el onboarding. Contacta al administrador.';
  if (status === 'pendiente_pago')
    return 'Tu cuenta está pendiente de pago. Contacta al administrador.';
  return 'Tu cuenta no está activa. Contacta al administrador.';
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
      <header className="ek-header-glass">
        <div className="ek-header-inner">
          <Link
            to="/app"
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '10px',
              textDecoration: 'none'
            }}
          >
            <span style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '22px',
              fontWeight: 700,
              letterSpacing: '-0.04em',
              color: 'var(--ek-mustard)'
            }}>EKKO</span>
            <span className="ek-eyebrow" style={{ paddingTop: '4px' }}>STUDIO</span>
          </Link>
        </div>
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/reservar" element={<Reservar />} />
          <Route path="/estudios" element={<Estudios />} />
          <Route path="/estudios/:slug" element={<EstudioDetalle />} />
          <Route path="/historial" element={<Historial />} />
          <Route path="/perfil" element={<Perfil />} />
          <Route path="/qr/:reservaId" element={<MiQR />} />
        </Routes>
      </Suspense>

      <BottomNav />
    </div>
  );
}
