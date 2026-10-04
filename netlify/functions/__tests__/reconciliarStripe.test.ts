import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  piRetrieve: vi.fn(), invRetrieve: vi.fn(), csRetrieve: vi.fn(), chRetrieve: vi.fn(), dpList: vi.fn(),
  // mutadores: si C2 llamara alguno, el test falla (deben quedar en 0).
  piCreate: vi.fn(), refundCreate: vi.fn(), subUpdate: vi.fn()
}));

vi.mock('../_lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: { retrieve: h.piRetrieve, create: h.piCreate },
    invoices: { retrieve: h.invRetrieve },
    checkout: { sessions: { retrieve: h.csRetrieve } },
    charges: { retrieve: h.chRetrieve },
    disputes: { list: h.dpList },
    refunds: { create: h.refundCreate },
    subscriptions: { update: h.subUpdate }
  })
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: h.rpc }) }));

import { handler } from '../reconciliar-stripe/index';

const UUID = '11111111-1111-1111-1111-111111111111';
const req = (body: Record<string, unknown>, auth = true) => ({
  httpMethod: 'POST', headers: auth ? { authorization: 'Bearer jwt' } : {},
  body: JSON.stringify(body), isBase64Encoded: false
} as never);
const call = (body: Record<string, unknown>, auth = true) =>
  handler(req(body, auth), {} as never) as Promise<{ statusCode: number; body: string }>;

const OLD = 1_600_000_000; // 2020 → fuera de la ventana de gracia (recent=false)
const bundlePago = (over: Record<string, unknown> = {}) => ({
  authorized: true, tenant_id: 'T', stripe_account_id: 'acct_1', stripe_charges_enabled: true,
  sujeto: 'pago', sujeto_id: UUID,
  pagos: [{ id: 'p1', usuario_id: 'u', membresia_id: 'm', concepto: 'plan', monto_centavos: 50000, moneda: 'MXN', metodo: 'stripe', referencia: 'pi_1', revierte_pago_id: null, created_at: '2020-01-01T00:00:00Z' }],
  membresias: [{ id: 'm', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'activa' }],
  socios: [{ id: 'u', stripe_customer_id: 'cus_1' }], disputas: [], inbox: [], ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://x'; process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  h.rpc.mockResolvedValue({ data: bundlePago(), error: null });
  h.piRetrieve.mockResolvedValue({ amount: 50000, currency: 'mxn', customer: 'cus_1', created: OLD, latest_charge: { id: 'ch_1', amount_refunded: 0, disputed: false, currency: 'mxn' } });
});

const noMutations = () => {
  expect(h.piCreate).not.toHaveBeenCalled();
  expect(h.refundCreate).not.toHaveBeenCalled();
  expect(h.subUpdate).not.toHaveBeenCalled();
};

describe('W6-C2 — reconciliar-stripe (read-only, admin, tenant-scoped)', () => {
  it('sin token → 401', async () => { expect((await call({ sujeto: 'pago', id: UUID }, false)).statusCode).toBe(401); });

  it('sujeto inválido → 400', async () => { expect((await call({ sujeto: 'x', id: UUID })).statusCode).toBe(400); });

  it('#26 Stripe ID crudo como id → 400 (no bypass de ownership)', async () => {
    for (const bad of ['pi_123', 'cus_123', 'acct_1', 'sub_1', 'ch_1']) {
      const res = await call({ sujeto: 'pago', id: bad });
      expect(res.statusCode).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled(); // ni siquiera llega a la RPC
  });

  it('RPC RECON_NO_ADMIN → 403; RECON_NOT_FOUND → 404', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'RECON_NO_ADMIN' } });
    expect((await call({ sujeto: 'pago', id: UUID })).statusCode).toBe(403);
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'RECON_NOT_FOUND' } });
    expect((await call({ sujeto: 'pago', id: UUID })).statusCode).toBe(404);
  });

  it('pago MATCH + CERO mutaciones Stripe', async () => {
    const res = await call({ sujeto: 'pago', id: UUID });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.result).toBe('MATCH');
    expect(h.piRetrieve).toHaveBeenCalledWith('pi_1', { expand: ['latest_charge'] }, { stripeAccount: 'acct_1' });
    noMutations();
  });

  it('#19 Stripe timeout → UNKNOWN (no MISSING_STRIPE)', async () => {
    h.piRetrieve.mockRejectedValueOnce(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }));
    const b = JSON.parse((await call({ sujeto: 'pago', id: UUID })).body);
    expect(b.result).toBe('UNKNOWN'); noMutations();
  });

  it('resource_missing autoritativo con interno presente → MISSING_STRIPE', async () => {
    h.piRetrieve.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'resource_missing' }));
    const b = JSON.parse((await call({ sujeto: 'pago', id: UUID })).body);
    expect(b.result).toBe('MISSING_STRIPE'); noMutations();
  });

  it('refund parcial coincide → MATCH; routing invoice usa invoices.retrieve', async () => {
    h.rpc.mockResolvedValueOnce({ data: bundlePago({ pagos: [
      { id: 'p1', usuario_id: 'u', membresia_id: 'm', concepto: 'plan', monto_centavos: 50000, moneda: 'MXN', metodo: 'stripe', referencia: 'in_1', revierte_pago_id: null, created_at: '2020-01-01T00:00:00Z' },
      { id: 'p2', usuario_id: 'u', membresia_id: 'm', concepto: 'reembolso', monto_centavos: -20000, moneda: 'MXN', metodo: 'stripe', referencia: 're_1', revierte_pago_id: 'p1', created_at: '2020-01-02T00:00:00Z' }
    ] }), error: null });
    h.invRetrieve.mockResolvedValue({ amount_paid: 50000, currency: 'mxn', customer: 'cus_1', created: OLD, charge: { id: 'ch_1', amount_refunded: 20000, disputed: false } });
    const b = JSON.parse((await call({ sujeto: 'pago', id: UUID })).body);
    expect(b.result).toBe('MATCH');
    expect(h.invRetrieve).toHaveBeenCalled(); expect(h.piRetrieve).not.toHaveBeenCalled();
    noMutations();
  });

  it('sesión con plan + inscripción (misma referencia) → UN solo objeto reconciliado, MATCH', async () => {
    h.rpc.mockResolvedValueOnce({ data: bundlePago({ pagos: [
      { id: 'p1', usuario_id: 'u', membresia_id: 'm', concepto: 'plan', monto_centavos: 50000, moneda: 'MXN', metodo: 'stripe', referencia: 'cs_1', revierte_pago_id: null, created_at: '2020-01-01T00:00:00Z' },
      { id: 'p2', usuario_id: 'u', membresia_id: 'm', concepto: 'inscripcion', monto_centavos: 30000, moneda: 'MXN', metodo: 'stripe', referencia: 'cs_1', revierte_pago_id: null, created_at: '2020-01-01T00:00:00Z' }
    ] }), error: null });
    h.csRetrieve.mockResolvedValue({ amount_total: 80000, currency: 'mxn', customer: 'cus_1', created: OLD,
      payment_intent: { amount: 80000, currency: 'mxn', latest_charge: { id: 'ch_1', amount_refunded: 0, disputed: false } } });
    const b = JSON.parse((await call({ sujeto: 'pago', id: UUID })).body);
    expect(b.detalles).toHaveLength(1);              // un objeto Stripe, no dos filas
    expect(b.detalles[0].pago_ids).toEqual(['p1', 'p2']);
    expect(b.result).toBe('MATCH');
    expect(h.csRetrieve).toHaveBeenCalledTimes(1);   // una sola lectura
    noMutations();
  });

  it('socio con 2 pagos (MATCH + AMOUNT_MISMATCH) → resumen ATTENTION, nunca oculta', async () => {
    h.rpc.mockResolvedValueOnce({ data: bundlePago({ sujeto: 'socio', pagos: [
      { id: 'p1', usuario_id: 'u', membresia_id: 'm', concepto: 'plan', monto_centavos: 50000, moneda: 'MXN', metodo: 'stripe', referencia: 'pi_1', revierte_pago_id: null, created_at: '2020-01-01T00:00:00Z' },
      { id: 'p2', usuario_id: 'u', membresia_id: 'm', concepto: 'plan', monto_centavos: 30000, moneda: 'MXN', metodo: 'stripe', referencia: 'pi_2', revierte_pago_id: null, created_at: '2020-01-01T00:00:00Z' }
    ] }), error: null });
    h.piRetrieve.mockImplementation(async (ref: string) =>
      ref === 'pi_1' ? { amount: 50000, currency: 'mxn', customer: 'cus_1', created: OLD, latest_charge: { id: 'c1', amount_refunded: 0, disputed: false } }
                     : { amount: 99999, currency: 'mxn', customer: 'cus_1', created: OLD, latest_charge: { id: 'c2', amount_refunded: 0, disputed: false } });
    const b = JSON.parse((await call({ sujeto: 'socio', id: UUID })).body);
    expect(b.resumen.total_payments).toBe(2);
    expect(b.resumen.mismatches).toBe(1);
    expect(b.resumen.overall).toBe('ATTENTION');
    noMutations();
  });
});
