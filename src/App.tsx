import { Suspense } from 'react';
import { lazyConRecarga } from '@shared/lib/lazyConRecarga';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { ToastProvider } from '@shared/providers/ToastProvider';
import ConexionBanner from '@shared/components/ConexionBanner';
import { isMarketingRoot, isTenantFromSubdomain } from '@shared/providers/TenantProvider';

const PublicLayout = lazyConRecarga(() => import('@public/PublicLayout'));
const MemberLayout = lazyConRecarga(() => import('@member/MemberLayout'));
const AdminLayout = lazyConRecarga(() => import('@admin/AdminLayout'));
const ReceptionLayout = lazyConRecarga(() => import('@reception/ReceptionLayout'));
const Onboarding = lazyConRecarga(() => import('@public/pages/Onboarding'));
const SalaLanding = lazyConRecarga(() => import('@public/pages/SalaLanding'));
const RecuperarContrasena = lazyConRecarga(() => import('@public/pages/RecuperarContrasena'));
const NuevaContrasena = lazyConRecarga(() => import('@public/pages/NuevaContrasena'));
const ActivarCuenta = lazyConRecarga(() => import('@public/pages/ActivarCuenta'));
const Recibo = lazyConRecarga(() => import('@public/pages/Recibo'));

export default function App() {
  // En el dominio raíz de SALA, "/" es la landing de producto (no la de un gym).
  const marketing = isMarketingRoot();
  // Superficies de MARKETING (onboarding + landing de producto): no tienen sentido
  // en el subdominio de un gym real → redirigir a "/". En dev/preview se permiten.
  const enSubdominioTenant = isTenantFromSubdomain();

  return (
    <ToastProvider>
      <ConexionBanner />
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/app/*" element={<MemberLayout />} />
          <Route path="/admin/*" element={<AdminLayout />} />
          <Route path="/recepcion/*" element={<ReceptionLayout />} />
          <Route path="/para-gimnasios" element={enSubdominioTenant ? <Navigate to="/" replace /> : <SalaLanding />} />
          <Route path="/registro" element={enSubdominioTenant ? <Navigate to="/" replace /> : <Onboarding />} />
          <Route path="/recuperar" element={<RecuperarContrasena />} />
          <Route path="/nueva-contrasena" element={<NuevaContrasena />} />
          <Route path="/activar" element={<ActivarCuenta />} />
          <Route path="/recibo/:id" element={<Recibo />} />
          <Route path="/" element={marketing ? <SalaLanding /> : <PublicLayout />} />
          <Route path="/*" element={<PublicLayout />} />
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}
