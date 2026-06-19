import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from '@shared/components/ErrorBoundary';
import { TenantProvider } from '@shared/providers/TenantProvider';
import { AuthProvider } from '@shared/providers/AuthProvider';
import { initSentry } from '@shared/lib/sentry';

import './styles/tailwind.css';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/sala.css';

initSentry();

// PWA auto-update: cuando un service worker NUEVO toma control (tras un deploy),
// recargamos la pestaña para servir la versión nueva sin que el usuario tenga
// que matar el cache a mano. La config ya usa registerType:'autoUpdate'
// (skipWaiting + clientsClaim), así que el SW nuevo se activa solo; esto cierra
// el último eslabón: recargar la pestaña abierta.
//   - hadController distingue UPDATE (ya había SW) de la 1ra instalación (no
//     recargamos en la 1ra, donde controller pasa de null → SW por clients.claim).
if ('serviceWorker' in navigator) {
  const hadController = navigator.serviceWorker.controller != null;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <TenantProvider>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </TenantProvider>
    </ErrorBoundary>
  </StrictMode>
);
