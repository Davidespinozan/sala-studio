import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripeIdemKey } from '../_lib/stripeIdempotency';

// ── Mocks (W6-B3): dependencias de comprar-producto. Sin Stripe/Supabase reales.
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  piCreate: vi.fn(),
  refundCreate: vi.fn(),
  custRetrieve: vi.fn(),
  order: [] as string[] // registra el orden de efectos clave
}));

vi.mock('../_lib/stripe', () => ({
  getStripe: () => ({
    customers: { retrieve: h.custRetrieve },
    paymentMethods: { list: vi.fn(async () => ({ data: [{ id: 'pm_1' }] })) },
    paymentIntents: { create: h.piCreate },
    refunds: { create: h.refundCreate }
  })
}));
vi.mock('../_lib/connectBilling', () => ({ getOrCreateSocioCustomer: vi.fn(async () => 'cus_1') }));

// Supabase: auth + builders por tabla + rpc. Devuelve lo mínimo que el handler lee.
vi.mock('@supabase/supabase-js', () => {
  const build = (table: string) => {
    const state: { cols: string } = { cols: '' };
    const chain: any = {
      select: (c: string) => { state.cols = c || ''; return chain; },
      eq: () => chain, not: () => chain, order: () => chain, limit: () => chain,
      in: async () => ({ data: [
        { id: 'p1', tenant_id: 'T1', activo: true, precio_centavos: 50000, moneda: 'MXN', nombre: 'Agua' }
      ], error: null }),
      maybeSingle: async () => {
        if (table === 'usuarios' && state.cols.includes('rol')) return { data: { id: 'U1', tenant_id: 'T1', rol: 'miembro' }, error: null };
        if (table === 'usuarios') return { data: { status: 'activo', stripe_customer_id: 'cus_1' }, error: null };
        if (table === 'tenants') return { data: { slug: 'gym', config: { modulos: { tienda: true }, tienda: { venta_socio: true } }, stripe_account_id: 'acct_1', stripe_charges_enabled: true }, error: null };
        if (table === 'pagos') return { data: null, error: null };
        return { data: null, error: null };
      }
    };
    return chain;
  };
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: 'auth_1', email: 'a@x.dev' } }, error: null }) },
      from: (t: string) => build(t),
      rpc: h.rpc
    })
  };
});

import { handler } from '../comprar-producto/index';

const req = (body: Record<string, unknown>) => ({
  httpMethod: 'POST', headers: { authorization: 'Bearer jwt' }, body: JSON.stringify(body), isBase64Encoded: false
} as never);
const call = (body: Record<string, unknown>) => handler(req(body), {} as never) as Promise<{ statusCode: number; body: string }>;
const baseBody = { items: [{ producto_id: 'p1', cantidad: 1 }], entrega_tipo: 'recepcion', idempotency_token: 'tok_cliente_123' };

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  process.env.VITE_SUPABASE_URL = 'http://x'; process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'; process.env.STRIPE_SECRET_KEY = 'sk_test'; process.env.SALA_SOCIO_FEE_PERCENT = '0';
  h.custRetrieve.mockResolvedValue({ invoice_settings: { default_payment_method: 'pm_1' } });
  h.piCreate.mockImplementation(async () => { h.order.push('stripe'); return { id: 'pi_new', status: 'succeeded' }; });
  // rpc por nombre; el reclamar se configura por test.
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'compra_intento_reclamar') { h.order.push('reclamar'); return { data: { token: 'tok_cliente_123', estado: 'abierta', reuso: false, resultado: null }, error: null }; }
    if (fn === 'registrar_venta_online') return { data: { venta_id: 'v1' }, error: null };
    if (fn === 'compra_intento_resolver') { h.order.push('resolver'); return { data: null, error: null }; }
    return { data: null, error: null };
  });
});

describe('W6-B3 — comprar-producto: intención de compra durable', () => {
  it('reclama la intención ANTES del efecto en Stripe (ordering)', async () => {
    const res = await call(baseBody);
    expect(res.statusCode).toBe(200);
    expect(h.order.indexOf('reclamar')).toBeLessThan(h.order.indexOf('stripe'));
  });

  it('la clave de idempotencia se DERIVA del token de la intención', async () => {
    await call(baseBody);
    const opts = h.piCreate.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe(stripeIdemKey('tienda-compra', ['T1', 'U1', 'tok_cliente_123']));
  });

  it('token adoptado (pérdida de localStorage) → la clave usa el token ABIERTO, no el del cliente', async () => {
    // El cliente manda tok_NUEVO pero el server adopta la intención abierta tok_VIEJO.
    h.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'compra_intento_reclamar') return { data: { token: 'tok_VIEJO', estado: 'abierta', reuso: true, resultado: null }, error: null };
      if (fn === 'registrar_venta_online') return { data: {}, error: null };
      if (fn === 'compra_intento_resolver') return { data: null, error: null };
      return { data: null, error: null };
    });
    await call({ ...baseBody, idempotency_token: 'tok_NUEVO' });
    const opts = h.piCreate.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe(stripeIdemKey('tienda-compra', ['T1', 'U1', 'tok_VIEJO']));
  });

  it('intención YA cobrada → REPLAY sin recobrar (retry seguro tras falla ambigua)', async () => {
    h.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'compra_intento_reclamar') return { data: { token: 'tok_cliente_123', estado: 'cobrada', reuso: true, resultado: { paid: true, referencia: 'pi_old' } }, error: null };
      return { data: null, error: null };
    });
    const res = await call(baseBody);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ paid: true, referencia: 'pi_old' });
    expect(h.piCreate).not.toHaveBeenCalled(); // NO segundo cargo
  });

  it('éxito → resuelve la intención como cobrada con el PI', async () => {
    await call(baseBody);
    const resolverCall = h.rpc.mock.calls.find((c) => c[0] === 'compra_intento_resolver');
    expect(resolverCall?.[1]).toMatchObject({ p_estado: 'cobrada', p_pi: 'pi_new' });
  });

  it('payload alterado con el mismo token → 400, sin cobrar', async () => {
    h.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'compra_intento_reclamar') return { data: null, error: { message: 'INTENTO_PAYLOAD_DISTINTO' } };
      return { data: null, error: null };
    });
    const res = await call(baseBody);
    expect(res.statusCode).toBe(400);
    expect(h.piCreate).not.toHaveBeenCalled();
  });

  it('sin token → 400, ni siquiera reclama ni cobra', async () => {
    const { idempotency_token, ...sinToken } = baseBody;
    void idempotency_token;
    const res = await call(sinToken);
    expect(res.statusCode).toBe(400);
    expect(h.rpc.mock.calls.some((c) => c[0] === 'compra_intento_reclamar')).toBe(false);
    expect(h.piCreate).not.toHaveBeenCalled();
  });
});
