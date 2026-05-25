import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useRoleRedirect } from '@shared/hooks/useRoleRedirect';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { TenantLogo } from '@shared/components/TenantLogo';

const Landing = lazy(() => import('./pages/Landing'));
const Login = lazy(() => import('./pages/Login'));
const Signup = lazy(() => import('./pages/Signup'));

export default function PublicLayout() {
  const { authUser, signOut } = useAuth();
  const location = useLocation();
  const enLogin = location.pathname === '/login';
  useRoleRedirect(['/', '/login', '/signup']);

  return (
    <div className="ek-page">
      <DemoBanner vista="Landing" />
      <header
        style={{
          padding: '1rem 1.25rem',
          borderBottom: '1px solid var(--ek-line)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}
      >
        <Link to="/" style={{ textDecoration: 'none', display: 'inline-block' }}>
          <TenantLogo variant="completo" height={28} fallbackFontSize={18} showSuffix={true} />
        </Link>
        <nav style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {authUser ? (
            <>
              <Link to="/app" className="ek-cta" style={{ padding: '0.625rem 1.25rem', minHeight: '40px' }}>
                Mi cuenta
              </Link>
              <button
                onClick={signOut}
                style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}
              >
                Salir
              </button>
            </>
          ) : !enLogin ? (
            <Link
              to="/login"
              className="ek-cta"
              style={{ padding: '0.625rem 1.25rem', minHeight: '40px' }}
            >
              Iniciar sesión
            </Link>
          ) : null}
        </nav>
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
        </Routes>
      </Suspense>
    </div>
  );
}
