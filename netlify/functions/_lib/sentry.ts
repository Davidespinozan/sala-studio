import * as Sentry from '@sentry/node';
import type { Handler, HandlerEvent, HandlerContext, HandlerResponse } from '@netlify/functions';

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

/**
 * Envuelve un handler de cron con un Cron Monitor de Sentry (dead-man switch):
 * check-in al empezar, 'ok' si respondió < 500, 'error' si no. Si el cron NO
 * corre a su hora (el modo de falla que tuvimos: [[scheduled_functions]]
 * ignorado por semanas), Sentry avisa por correo solo.
 *
 * El plan gratuito incluye UN monitor: se usa en cron-expirar-membresias (los
 * crons mueren en grupo — config/deploy/env — así que un centinela detecta la
 * clase entera; los individuales se cubren con los chequeos de frescura).
 */
export function conMonitorCron(slug: string, cronExpr: string, handler: Handler): Handler {
  return async (event: HandlerEvent, context: HandlerContext) => {
    if (!dsn) return (await handler(event, context)) as HandlerResponse;
    init();
    const monitorConfig = {
      schedule: { type: 'crontab', value: cronExpr },
      checkinMargin: 60, // min de gracia antes de alertar "no corrió"
      maxRuntime: 10,
      timezone: 'Etc/UTC'
    } as const;
    const checkInId = Sentry.captureCheckIn({ monitorSlug: slug, status: 'in_progress' }, monitorConfig);
    let res: HandlerResponse | undefined = undefined;
    try {
      res = (await handler(event, context)) as HandlerResponse | undefined;
    } finally {
      const okRun = !!res && typeof res.statusCode === 'number' && res.statusCode < 500;
      Sentry.captureCheckIn(
        { checkInId, monitorSlug: slug, status: okRun ? 'ok' : 'error' },
        monitorConfig
      );
      await Sentry.flush(2000).catch(() => {});
    }
    return res as HandlerResponse;
  };
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
