import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';

const Scanner = lazy(() => import('./pages/Scanner'));

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
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Scanner />} />
        </Routes>
      </Suspense>
    </>
  );
}
