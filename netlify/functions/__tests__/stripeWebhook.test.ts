import { describe, it, expect, vi, beforeEach } from 'vitest';

// Los mocks se hoistean: sus fns viven en vi.hoisted para poder referenciarlas.
const h = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  subRetrieve: vi.fn(),
  rpc: vi.fn(),
  reportar: vi.fn(async () => {})
}));

vi.mock('../_lib/stripe', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: h.constructEvent },
    subscriptions: { retrieve: h.subRetrieve, list: vi.fn(), update: vi.fn() },
    setupIntents: { retrieve: vi.fn() },
    customers: { update: vi.fn() },
    invoices: { retrieve: vi.fn(), pay: vi.fn() }
  }),
  Stripe: class {}
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: h.rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      insert: async () => ({ error: null })
    })
  })
}));

vi.mock('../_lib/sentry', () => ({ reportarErrorServidor: h.reportar }));

import { handler } from '../stripe-webhook/index';

let claimResult: unknown = { id: 'evt_1', estado: 'processing' };
let dispatchResult: { data: unknown; error: unknown } = { data: { ok: true }, error: null };
function wireRpc() {
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === '_stripe_inbox_receive') return { data: { nuevo: true, estado: 'received' }, error: null };
    if (fn === '_stripe_inbox_claim') return { data: claimResult, error: null };
    if (fn === 'stripe_procesar_socio') return dispatchResult;
    if (fn === '_stripe_inbox_processed') return { data: true, error: null };
    if (fn === '_stripe_inbox_failed') return { data: 'failed', error: null };
    return { data: null, error: null };
  });
}

const ev = (over: Record<string, unknown>) => ({ id: 'evt_1', created: 1_700_000_000, ...over });
const req = () => ({ httpMethod: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}', isBase64Encoded: false } as never);
const call = () => handler(req(), {} as never) as Promise<{ statusCode: number; body: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  claimResult = { id: 'evt_1', estado: 'processing' };
  dispatchResult = { data: { ok: true }, error: null };
  wireRpc();
  process.env.STRIPE_WEBHOOK_SECRET_SOCIO = 'whsec_test';
  h.constructEvent.mockImplementation(() => ({ account: 'acct_1' }));
});

describe('stripe-webhook (Connect) — pipeline durable', () => {
  it('FAIL-CLOSED: sin secret → 500, no verifica firma', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET_SOCIO;
    const res = await call();
    expect(res.statusCode).toBe(500);
    expect(h.constructEvent).not.toHaveBeenCalled();
  });

  it('firma inválida → 400 (fail-closed), no toca el inbox', async () => {
    h.constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await call();
    expect(res.statusCode).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('checkout.session.completed (subscription) → dispatcher activar + 200', async () => {
    h.subRetrieve.mockResolvedValue({ items: { data: [{ current_period_end: 1_700_100_000 }] } });
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', mode: 'subscription', metadata: { app: 'sala', usuario_id: 'u', tier_id: 't', inscripcion_centavos: '0' }, amount_total: 50000, customer: 'cus_1', subscription: 'sub_1' } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    const disp = h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio');
    expect(disp?.[1]).toMatchObject({ p_kind: 'activar' });
  });

  it('evento duplicado (claim=false) → 200 sin ejecutar el efecto', async () => {
    claimResult = null;
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', metadata: { app: 'sala' } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(h.rpc.mock.calls.some((c) => c[0] === 'stripe_procesar_socio')).toBe(false);
  });

  it('error transitorio del dispatcher → inboxFailed + 500 (sin delete-on-error)', async () => {
    dispatchResult = { data: null, error: { message: 'boom transitorio' } };
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', metadata: { app: 'sala' } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(500);
    expect(h.rpc.mock.calls.some((c) => c[0] === '_stripe_inbox_failed')).toBe(true);
    expect(h.rpc.mock.calls.some((c) => c[0] === '_stripe_inbox_receive')).toBe(true);
  });

  it('tienda con error PERMANENTE (SIN_STOCK) → processed + 200 (cobrado, no reprocesar)', async () => {
    dispatchResult = { data: null, error: { message: 'SIN_STOCK: agotado' } };
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', metadata: { app: 'sala', tipo: 'tienda', tenant_id: 'T', usuario_id: 'u', items: '[{"producto_id":"p","cantidad":1}]', entrega_tipo: 'mostrador' } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(h.rpc.mock.calls.some((c) => c[0] === '_stripe_inbox_processed')).toBe(true);
    expect(h.reportar).toHaveBeenCalled();
  });

  it('account.updated → dispatcher account', async () => {
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'account.updated',
      data: { object: { id: 'acct_1', charges_enabled: true, details_submitted: true } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    const disp = h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio');
    expect(disp?.[1]).toMatchObject({ p_kind: 'account' });
  });

  it('evento no-sala → 200 sin tocar el inbox', async () => {
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', mode: 'subscription', metadata: { app: 'otra_cosa' } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
