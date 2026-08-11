import * as Sentry from '@sentry/node';

/**
 * Sentry para el BACKEND (funciones de Netlify). El frontend ya reporta desde
 * src/shared/lib/sentry.ts; las funciones fallaban en silencio: el error
 * quedaba en logs de Netlify que nadie lee (E: los crons rotos por semanas).
 *
 * Reusa el mismo proyecto de Sentry: VITE_SENTRY_DSN ya está en las env vars
 * del sitio y las funciones también la ven (SENTRY_DSN tiene prioridad si un
 * día se quiere separar backend en otro proyecto).
 *
 * En serverless SIEMPRE hay que hacer flush: el proceso muere al responder y
 * sin flush el evento se pierde.
 */
const dsn = process.env.SENTRY_DSN || process.env.VITE_SENTRY_DSN || '';
let inicializado = false;

function init(): void {
  if (inicializado || !dsn) return;
  Sentry.init({
    dsn,
    // Netlify define CONTEXT=production en el sitio publicado.
    environment: process.env.CONTEXT === 'production' ? 'production' : 'preview'
  });
  inicializado = true;
}

/** Reporta un error del backend a Sentry (y siempre a console, como antes). */
export async function reportarErrorServidor(
  origen: string,
  err: unknown,
  extra?: Record<string, unknown>
): Promise<void> {
  console.error(`[${origen}]`, err instanceof Error ? err.message : err);
  if (!dsn) return;
  try {
    init();
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { funcion: origen },
      extra
    });
    await Sentry.flush(2000);
  } catch {
    /* reportar el error nunca debe tumbar la función */
  }
}
