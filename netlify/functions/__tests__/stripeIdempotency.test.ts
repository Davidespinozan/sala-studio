import { describe, it, expect } from 'vitest';
import { stripeIdemKey, validIntentToken } from '../_lib/stripeIdempotency';

describe('W6-B — stripeIdemKey: idempotencia estable por intención', () => {
  it('misma intención → MISMA clave (retry-safe, determinista entre llamadas)', () => {
    const a = stripeIdemKey('tier-price', ['T1', 'tier_x', 50000, 'mxn', 'month', 1]);
    const b = stripeIdemKey('tier-price', ['T1', 'tier_x', 50000, 'mxn', 'month', 1]);
    expect(a).toBe(b);
    // y una tercera vez: sin deriva por Date.now()/random/estado de proceso.
    expect(stripeIdemKey('tier-price', ['T1', 'tier_x', 50000, 'mxn', 'month', 1])).toBe(a);
  });

  it('intención legítimamente distinta → clave distinta (tier, monto, intervalo)', () => {
    const base = stripeIdemKey('tier-price', ['T1', 'tier_x', 50000, 'mxn', 'month', 1]);
    expect(stripeIdemKey('tier-price', ['T1', 'tier_y', 50000, 'mxn', 'month', 1])).not.toBe(base);
    expect(stripeIdemKey('tier-price', ['T1', 'tier_x', 60000, 'mxn', 'month', 1])).not.toBe(base);
    expect(stripeIdemKey('tier-price', ['T1', 'tier_x', 50000, 'mxn', 'year', 1])).not.toBe(base);
  });

  it('operación distinta con mismas partes → clave distinta', () => {
    expect(stripeIdemKey('refund-venta', ['pi_1'])).not.toBe(stripeIdemKey('tienda-compra', ['pi_1']));
  });

  it('resistencia a colisión cross-tenant (misma intención, tenant distinto)', () => {
    const t1 = stripeIdemKey('connect-account', ['tenant_A']);
    const t2 = stripeIdemKey('connect-account', ['tenant_B']);
    expect(t1).not.toBe(t2);
    const c1 = stripeIdemKey('tienda-compra', ['tenant_A', 'socio_1', 'tok_1']);
    const c2 = stripeIdemKey('tienda-compra', ['tenant_B', 'socio_1', 'tok_1']);
    expect(c1).not.toBe(c2);
  });

  it('formato canónico sala:…:v1 y acotado a SALA', () => {
    expect(stripeIdemKey('refund-venta', ['pi_1'])).toBe('sala:refund-venta:pi_1:v1');
    expect(stripeIdemKey('connect-account', ['T1'])).toMatch(/^sala:connect-account:T1:v1$/);
  });

  it('versionable: cambiar la versión cambia la clave', () => {
    expect(stripeIdemKey('tier-price', ['T1'], 2)).not.toBe(stripeIdemKey('tier-price', ['T1'], 1));
    expect(stripeIdemKey('tier-price', ['T1'], 2)).toMatch(/:v2$/);
  });

  it('FAIL-CLOSED: parte vacía/ausente → lanza (no inventa clave débil)', () => {
    expect(() => stripeIdemKey('tienda-compra', ['T1', 'socio_1', ''])).toThrow(/IDEM_PARTE_VACIA/);
    expect(() => stripeIdemKey('tienda-compra', ['T1', 'socio_1', null])).toThrow(/IDEM_PARTE_VACIA/);
    expect(() => stripeIdemKey('tienda-compra', ['T1', undefined, 'tok'])).toThrow(/IDEM_PARTE_VACIA/);
    expect(() => stripeIdemKey('', ['T1'])).toThrow(/IDEM_SIN_OPERACION/);
  });

  it('separador seguro: espacios/":" en una parte no rompen el namespace', () => {
    const k = stripeIdemKey('tier-price', ['T 1', 'a:b']);
    expect(k.split(':').length).toBe(5); // sala + op + 2 partes saneadas + v1
    expect(k).toBe('sala:tier-price:T_1:a_b:v1');
  });

  it('respeta el límite de 255 chars de Stripe (hash estable si se excede)', () => {
    const grande = 'x'.repeat(400);
    const k1 = stripeIdemKey('tienda-compra', ['T', grande]);
    const k2 = stripeIdemKey('tienda-compra', ['T', grande]);
    expect(k1.length).toBeLessThanOrEqual(255);
    expect(k1).toBe(k2); // el colapso por hash sigue siendo determinista
    expect(k1).toMatch(/^sala:tienda-compra:[0-9a-f]{48}:v1$/);
  });

  it('un token por intento distingue compras legítimas del mismo carrito', () => {
    // dos taps de "Pagar" = dos intenciones distintas → claves distintas (cada
    // compra cobra); un reintento del MISMO tap reusa su token → misma clave.
    const compraA = stripeIdemKey('tienda-compra', ['T1', 'socio_1', 'tok_A']);
    const compraB = stripeIdemKey('tienda-compra', ['T1', 'socio_1', 'tok_B']);
    expect(compraA).not.toBe(compraB);
    expect(stripeIdemKey('tienda-compra', ['T1', 'socio_1', 'tok_A'])).toBe(compraA);
  });
});

describe('W6-B2 — validIntentToken: validación server-side del nonce de acción', () => {
  it('acepta un UUID/nonce con pinta segura', () => {
    expect(validIntentToken('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(validIntentToken('x-abc123-def456')).toBe('x-abc123-def456');
    expect(validIntentToken('  tok_valido_123  ')).toBe('tok_valido_123'); // trim
  });

  it('rechaza ausente / vacío / corto / caracteres peligrosos → null', () => {
    expect(validIntentToken(undefined)).toBeNull();
    expect(validIntentToken(null)).toBeNull();
    expect(validIntentToken('')).toBeNull();
    expect(validIntentToken('   ')).toBeNull();
    expect(validIntentToken('corto')).toBeNull();            // <8
    expect(validIntentToken('tok con espacio')).toBeNull();  // espacio
    expect(validIntentToken('tok/../../x')).toBeNull();      // '/'
    expect(validIntentToken('x'.repeat(201))).toBeNull();    // >200
    expect(validIntentToken(12345678)).toBeNull();           // no-string
  });
});

describe('W6-B2 — namespaces de las nuevas operaciones de estado', () => {
  it('reusar el MISMO token en operaciones distintas da claves DISTINTAS (namespacing)', () => {
    const tok = 'tok_compartido_123';
    const claves = [
      stripeIdemKey('tienda-compra', ['T1', 'socio_1', tok]),
      stripeIdemKey('plan-swap-socio', ['T1', 'sub_1', 'tier_x', tok]),
      stripeIdemKey('plan-swap-saas', ['T1', 'sub_1', 'pro', tok]),
      stripeIdemKey('addon-add', ['T1', 'sub_1', 'tienda', tok]),
      stripeIdemKey('addon-del', ['T1', 'sub_1', 'si_1', tok])
    ];
    expect(new Set(claves).size).toBe(claves.length); // todas distintas
  });

  it('swap: misma acción (mismo token) → misma clave; token nuevo → clave nueva', () => {
    const k1 = stripeIdemKey('plan-swap-socio', ['T1', 'sub_1', 'tier_x', 'tokA']);
    expect(stripeIdemKey('plan-swap-socio', ['T1', 'sub_1', 'tier_x', 'tokA'])).toBe(k1);
    expect(stripeIdemKey('plan-swap-socio', ['T1', 'sub_1', 'tier_x', 'tokB'])).not.toBe(k1);
  });

  it('addon on/off: distinta acción (add vs del) nunca colisiona aunque el token se repita', () => {
    expect(stripeIdemKey('addon-add', ['T1', 'sub_1', 'tienda', 'tok']))
      .not.toBe(stripeIdemKey('addon-del', ['T1', 'sub_1', 'si_1', 'tok']));
  });

  it('cross-tenant: mismo token/sub en tenants distintos → claves distintas', () => {
    expect(stripeIdemKey('plan-swap-saas', ['T1', 'sub_1', 'pro', 'tok']))
      .not.toBe(stripeIdemKey('plan-swap-saas', ['T2', 'sub_1', 'pro', 'tok']));
  });
});
