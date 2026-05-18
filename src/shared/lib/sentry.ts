import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN;
const environment = import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE;

export function initSentry(): void {
  if (!dsn) {
    console.info('[sentry] VITE_SENTRY_DSN no definida; observabilidad desactivada en este entorno');
    return;
  }

  Sentry.init({
    dsn,
    environment,
    tracesSampleRate: environment === 'production' ? 0.1 : 0,
    beforeSend(event) {
      const msg = event.exception?.values?.[0]?.value ?? '';
      // No es accionable: aborts intencionales y errores de red de chunks
      if (msg.includes('AbortError')) return null;
      if (msg.includes('ChunkLoadError')) return null;
      return event;
    }
  });
}

export function setSentryUser(userId: string | null, email?: string): void {
  if (!dsn) return;
  if (userId) {
    Sentry.setUser({ id: userId, email });
  } else {
    Sentry.setUser(null);
  }
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!dsn) {
    console.error('[error]', err, context);
    return;
  }
  Sentry.captureException(err, { extra: context });
}
