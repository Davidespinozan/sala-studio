import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useRoleRedirect } from '@shared/hooks/useRoleRedirect';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { ModoDemoBanner } from '@shared/components/ModoDemoBanner';
import { TenantLogo } from '@shared/components/TenantLogo';

const Landing = lazy(() => import('./pages/Landing'));
const Login = lazy(() => import('./pages/Login'));
const Signup = lazy(() => import('./pages/Signup'));

export default function PublicLayout() {
  const { authUser, signOut } = useAuth();
  const location = useLocation();
  const enLogin = location.pathname === '/login';
  const enLanding = location.pathname === '/';
  useRoleRedirect(['/', '/login', '/signup']);

  return (
    <div className="ek-page">
      <ModoDemoBanner />
      <DemoBanner vista="Landing" />
      <header
        style={{
          padding: '1rem 1.25rem',
          background: 'var(--grad-immersive)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
          display: 'flex',
          justifyContent: enLogin ? 'center' : 'space-between',
          alignItems: 'center'
        }}
      >
        <Link to="/" style={{ textDecoration: 'none', display: 'inline-block' }}>
          <TenantLogo variant="completo" height={58} fallbackFontSize={36} showSuffix={true} />
        </Link>
        <nav style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {enLanding && (
            <div className="landing-nav-links">
              <a href="#disciplinas" className="landing-nav-link">Clases</a>
              <a href="#instructores" className="landing-nav-link">Instructores</a>
              <a href="#membresias" className="landing-nav-link">Membresías</a>
              <a href="#contacto" className="landing-nav-link">Contacto</a>
            </div>
          )}
          {authUser ? (
            <>
              <Link to="/app" className="ek-cta" style={{ padding: '0.625rem 1.25rem', minHeight: '40px' }}>
                Mi cuenta
              </Link>
              <button
                onClick={signOut}
                style={{ fontSize: '0.875rem', color: 'rgba(255, 255, 255, 0.8)' }}
              >
                Salir
              </button>
            </>
          ) : !enLogin ? (
            <>
              <Link to="/login" className="landing-nav-link" style={{ marginRight: '4px' }}>
                Iniciar sesión
              </Link>
              <a
                href={enLanding ? '#membresias' : '/login'}
                className="ek-cta"
                style={{ padding: '0.625rem 1.25rem', minHeight: '40px' }}
              >
                Reservar clase
              </a>
            </>
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
