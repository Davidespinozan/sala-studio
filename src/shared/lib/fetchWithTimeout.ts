/**
 * fetch con AbortController y timeout configurable.
 * Lección directa de HSC §5: TODA llamada externa se envuelve aquí.
 *
 * @param url URL a llamar
 * @param init RequestInit estándar
 * @param timeoutMs timeout en milisegundos (default 30s)
 * @throws Error con mensaje user-friendly si timeout o network error
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal
    });
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('La petición tardó demasiado. Verifica tu conexión e intenta de nuevo.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
