import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { ToastProvider } from '@shared/providers/ToastProvider';
import { isMarketingRoot } from '@shared/providers/TenantProvider';

const PublicLayout = lazy(() => import('@public/PublicLayout'));
const MemberLayout = lazy(() => import('@member/MemberLayout'));
const AdminLayout = lazy(() => import('@admin/AdminLayout'));
const ReceptionLayout = lazy(() => import('@reception/ReceptionLayout'));
const Onboarding = lazy(() => import('@public/pages/Onboarding'));
const SalaLanding = lazy(() => import('@public/pages/SalaLanding'));
const RecuperarContrasena = lazy(() => import('@public/pages/RecuperarContrasena'));
const NuevaContrasena = lazy(() => import('@public/pages/NuevaContrasena'));

export default function App() {
  // En el dominio raíz de SALA, "/" es la landing de producto (no la de un gym).
  const marketing = isMarketingRoot();

  return (
    <ToastProvider>
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/app/*" element={<MemberLayout />} />
          <Route path="/admin/*" element={<AdminLayout />} />
          <Route path="/recepcion/*" element={<ReceptionLayout />} />
          <Route path="/para-gimnasios" element={<SalaLanding />} />
          <Route path="/registro" element={<Onboarding />} />
          <Route path="/recuperar" element={<RecuperarContrasena />} />
          <Route path="/nueva-contrasena" element={<NuevaContrasena />} />
          <Route path="/" element={marketing ? <SalaLanding /> : <PublicLayout />} />
          <Route path="/*" element={<PublicLayout />} />
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}
