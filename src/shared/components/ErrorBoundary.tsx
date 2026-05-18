import { Component, ReactNode } from 'react';
import * as Sentry from '@sentry/react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string | null }) {
    Sentry.captureException(error, {
      contexts: { react: { componentStack: errorInfo.componentStack } }
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
            background: 'var(--ek-cream)',
            color: 'var(--ek-black)',
            fontFamily: 'var(--ek-font-sans)',
            textAlign: 'center'
          }}
        >
          <p style={{ fontSize: '0.75rem', letterSpacing: '0.16em', color: 'var(--ek-mustard-deep)', marginBottom: '0.75rem' }}>
            ERROR
          </p>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Algo salió mal
          </h1>
          <p style={{ color: 'var(--ek-ink-muted)', marginBottom: '1.5rem', maxWidth: '32rem' }}>
            Ocurrió un error inesperado. El equipo de EKKO ya fue notificado.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.875rem 1.75rem',
              background: 'var(--ek-black)',
              color: 'var(--ek-cream)',
              borderRadius: 'var(--ek-radius-pill)',
              fontWeight: 600,
              minHeight: '44px'
            }}
          >
            Recargar
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
