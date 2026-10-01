/**
 * W6-B2 — token de INTENCIÓN por acción de negocio, estable ante reintentos.
 *
 * Invariante del lado cliente:
 *   UNA acción explícita del usuario  → UN token
 *   reintentos / re-render / fallo de red / refresh del MISMO intento → mismo token
 *   una acción NUEVA                  → token nuevo
 *
 * El token viaja al backend (`idempotency_token`) y ahí se vuelve la clave de
 * idempotencia de Stripe. Así un doble-tap / reenvío NO genera un segundo efecto
 * económico.
 *
 * Persistencia: `localStorage`. Sobrevive REFRESH y REINICIO del navegador (y es
 * compartido entre pestañas: dos pestañas con la MISMA acción en vuelo reusan el
 * token → Stripe las colapsa en un solo efecto, que es el lado SEGURO para un
 * cobro). `resolveIntent` lo borra al resolverse la acción, así una repetición
 * DELIBERADA posterior acuña token nuevo. NUNCA se deriva de contenido (dos
 * carritos idénticos comprados a propósito son dos intenciones distintas, que es
 * por qué `resolveIntent` corre entre una compra y la siguiente).
 *
 * Residuo conocido (ver propuesta W6-B2 `compra_intento` en el reporte): un
 * crash del navegador EXACTO entre el envío del cargo off_session y su respuesta,
 * seguido de reconstruir el carrito (que limpia el token), podría recobrar. Solo
 * un registro de intención durable server-side lo cierra del todo.
 *
 *   beginIntent(ns)   → token vivo de esa acción (lo acuña si no existe).
 *   resolveIntent(ns) → lo borra cuando la acción se RESOLVIÓ (respuesta
 *                       recibida: éxito o rechazo definitivo). En fallo de RED
 *                       NO se llama → el reintento reusa el mismo token.
 */

const PREFIX = 'sala:intent:';

function nuevoToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* entorno sin crypto: cae al fallback */ }
  // Fallback: se acuña UNA vez y se persiste; no es una clave derivada por
  // reintento (eso sí estaría prohibido), es un nonce de la acción.
  return `x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function beginIntent(ns: string): string {
  if (!ns) throw new Error('INTENT_SIN_NS');
  const key = PREFIX + ns;
  try {
    const vivo = localStorage.getItem(key);
    if (vivo) return vivo;
    const token = nuevoToken();
    localStorage.setItem(key, token);
    return token;
  } catch {
    // localStorage inaccesible (modo privado estricto, SSR): token efímero.
    // Mantiene la seguridad contra doble-tap dentro del mismo render; pierde la
    // durabilidad ante refresh (aceptable como degradación, no como norma).
    return nuevoToken();
  }
}

export function resolveIntent(ns: string): void {
  if (!ns) return;
  try {
    localStorage.removeItem(PREFIX + ns);
  } catch { /* noop */ }
}
