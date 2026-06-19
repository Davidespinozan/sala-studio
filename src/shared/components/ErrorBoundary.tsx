import { Component, ReactNode } from 'react';
import * as Sentry from '@sentry/react';

interface Props {
  children: ReactNode;
  /** 'fullscreen' (default) tumba a una pantalla completa; 'inline' muestra un
   *  fallback compacto que conserva el shell (sidebar/header/nav) y permite
   *  reintentar solo esa sección. */
  variant?: 'fullscreen' | 'inline';
  /** Si cambian, se resetea el error (p.ej. la ruta) → al navegar a otra
   *  sección el error desaparece sin recargar. */
  resetKeys?: unknown[];
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

function keysCambiaron(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return false;
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return true;
  }
  return false;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string | null }) {
    // Log a consola SIEMPRE — sin esto el error real queda invisible en dev.
    console.error('[ErrorBoundary] error capturado:', error);
    if (errorInfo.componentStack) {
      console.error('[ErrorBoundary] componentStack:', errorInfo.componentStack);
    }
    this.setState({ componentStack: errorInfo.componentStack ?? null });
    Sentry.captureException(error, {
      contexts: { react: { componentStack: errorInfo.componentStack } }
    });
  }

  componentDidUpdate(prevProps: Props) {
    // Navegó a otra ruta (resetKeys cambió) → limpiar el error para no quedar
    // pegado en el fallback al cambiar de sección.
    if (this.state.hasError && keysCambiaron(prevProps.resetKeys, this.props.resetKeys)) {
      this.setState({ hasError: false, error: null, componentStack: null });
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const esDev = import.meta.env.DEV;
    const detalleDev = esDev && this.state.error ? (
      <pre
        style={{
          marginTop: '2rem',
          maxWidth: 'min(900px, 92vw)',
          maxHeight: '50vh',
          overflow: 'auto',
          textAlign: 'left',
          fontSize: '12px',
          lineHeight: 1.5,
          background: '#1a1f1c',
          color: '#D8D3CB',
          padding: '16px',
          borderRadius: '8px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {String(this.state.error.stack ?? this.state.error.message)}
        {this.state.componentStack ? `\n\n--- componentStack ---${this.state.componentStack}` : ''}
      </pre>
    ) : null;

    // ── Inline: conserva el shell, reintenta solo esta sección ──
    if (this.props.variant === 'inline') {
      return (
        <div style={{ padding: '48px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <p style={{ fontSize: '11px', letterSpacing: '0.16em', color: 'var(--ek-mustard-deep, var(--sala-warning))', margin: '0 0 8px', fontWeight: 700 }}>
            ERROR
          </p>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: '0 0 6px', color: 'var(--ek-ink, var(--sala-text-primary))' }}>
            Algo salió mal en esta sección
          </h2>
          <p style={{ color: 'var(--ek-ink-muted, var(--sala-text-secondary))', margin: '0 0 20px', maxWidth: '28rem', fontSize: '14px' }}>
            Prueba de nuevo. Si sigue, recarga la página o cambia de sección.
          </p>
          <button onClick={this.handleReset} className="ek-cta" style={{ minHeight: '44px' }}>
            Reintentar
          </button>
          {detalleDev}
        </div>
      );
    }

    // ── Fullscreen (default, raíz de la app) ──
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
          Ocurrió un error inesperado. El equipo de SALA ya fue notificado.
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
        {detalleDev}
      </div>
    );
  }
}
