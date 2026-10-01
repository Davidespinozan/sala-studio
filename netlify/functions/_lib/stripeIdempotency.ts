import { createHash } from 'node:crypto';

/**
 * W6-B — claves de idempotencia ESTABLES para mutaciones SALA → Stripe.
 *
 * Invariante:
 *   misma intención lógica + reintento  → MISMA clave → nunca un segundo
 *                                          efecto económico/externo.
 *   intención legítimamente distinta     → clave distinta.
 *
 * Formato: `sala:<operacion>:<parte>:<parte>:…:v<version>`
 *   · prefijo `sala` acota al SaaS (la cuenta Stripe es compartida con HSC).
 *   · cada <parte> es un identificador DURABLE de la intención (tenant / objeto
 *     Stripe / token estable del cliente). NUNCA Date.now(), UUID por reintento,
 *     timestamp de request ni estado efímero de proceso.
 *   · sufijo de versión por si la semántica de una operación cambiara.
 *
 * Fail-closed: si alguna parte viene vacía, LANZA en vez de inventar una clave
 * débil — el llamador decide (cae a la clave que el SDK pone en sus reintentos
 * de red, o rechaza la operación). Stripe limita la clave a 255 chars; si se
 * excediera (no debería con ids normales), se colapsa a un hash estable.
 */

const MAX_LEN = 255;

/**
 * W6-B2: valida un token de intención que manda el cliente (nonce por acción).
 * Devuelve el token si tiene pinta de nonce seguro, o null si está ausente/
 * vacío/malformado. El llamador decide qué hacer con null (ignorarlo en ops
 * auto-idempotentes, o rechazar en un cobro).
 */
const INTENT_TOKEN_RE = /^[A-Za-z0-9:_-]{8,200}$/;
export function validIntentToken(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s && INTENT_TOKEN_RE.test(s) ? s : null;
}

export function stripeIdemKey(
  operacion: string,
  partes: Array<string | number | null | undefined>,
  version = 1
): string {
  if (!operacion) throw new Error('IDEM_SIN_OPERACION');
  const limpias = partes.map((p) => {
    const s = String(p ?? '').trim();
    if (!s) throw new Error(`IDEM_PARTE_VACIA:${operacion}`);
    return s.replace(/[\s:]+/g, '_'); // ':' es separador; sin espacios
  });
  const key = ['sala', operacion, ...limpias, `v${version}`].join(':');
  if (key.length > MAX_LEN) {
    const h = createHash('sha256').update(key).digest('hex').slice(0, 48);
    return `sala:${operacion}:${h}:v${version}`;
  }
  return key;
}
