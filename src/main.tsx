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
import './styles/ekko.css';

initSentry();

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
