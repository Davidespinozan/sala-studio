import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { CalendarClock, Users } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';

const Scanner = lazy(() => import('./pages/Scanner'));
const Socios = lazy(() => import('./pages/Socios'));
const SocioFicha = lazy(() => import('./pages/SocioFicha'));

/** Nav mínima de recepción: alterna entre "Hoy" (check-in) y "Socios". */
function RecepcionNav() {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '8px 16px',
    borderRadius: '999px',
    fontSize: '13px',
    fontWeight: 600,
    textDecoration: 'none',
    border: '1px solid transparent',
  };
  const linkStyle = ({ isActive }: { isActive: boolean }): React.CSSProperties =>
    isActive
      ? { ...base, background: 'var(--grad-immersive)', color: '#fff', borderColor: 'var(--sala-primary)' }
      : { ...base, background: 'var(--sala-surface)', color: 'var(--sala-text-secondary)', borderColor: 'var(--sala-border)' };

  return (
    <nav style={{ display: 'flex', gap: '8px', justifyContent: 'center', padding: '12px 16px 0' }}>
      <NavLink to="/recepcion" end style={linkStyle}>
        <CalendarClock size={16} /> Hoy
      </NavLink>
      <NavLink to="/recepcion/socios" style={linkStyle}>
        <Users size={16} /> Socios
      </NavLink>
    </nav>
  );
}

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
      <RecepcionNav />
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Scanner />} />
          <Route path="/socios" element={<Socios />} />
          <Route path="/socios/:id" element={<SocioFicha />} />
        </Routes>
      </Suspense>
    </>
  );
}
