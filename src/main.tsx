import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from '@shared/components/ErrorBoundary';
import { TenantProvider } from '@shared/providers/TenantProvider';
import { AuthProvider } from '@shared/providers/AuthProvider';
import { initSentry } from '@shared/lib/sentry';
import { intentarAutoRecarga } from '@shared/lib/autoReload';

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

// Versión vieja cacheada: el index.html viejo pide un chunk JS que ya no existe
// (tras un deploy) → Vite dispara 'vite:preloadError'. Limpiamos caché + hard
// reload UNA vez para traer la versión fresca en vez de dejar la pantalla rota.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault(); // evitamos que el error sin manejar tumbe la app
  void intentarAutoRecarga();
});

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
