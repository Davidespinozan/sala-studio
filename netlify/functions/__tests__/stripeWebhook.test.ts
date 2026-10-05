import { describe, it, expect, vi, beforeEach } from 'vitest';

// Los mocks se hoistean: sus fns viven en vi.hoisted para poder referenciarlas.
const h = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  subRetrieve: vi.fn(),
  rpc: vi.fn(),
  reportar: vi.fn(async () => {}),
  csList: vi.fn(),
  invPayList: vi.fn(),
  // tabla → fila devuelta por maybeSingle(); default = el comportamiento previo
  // (solo 'tenants' trae algo, para el push de disputa abierta).
  fromData: (table: string): unknown => (table === 'tenants' ? { id: 'tenant_1' } : null)
}));

vi.mock('../_lib/stripe', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: h.constructEvent },
    subscriptions: { retrieve: h.subRetrieve, list: vi.fn(), update: vi.fn() },
    setupIntents: { retrieve: vi.fn() },
    customers: { update: vi.fn() },
    invoices: { retrieve: vi.fn(), pay: vi.fn() },
    checkout: { sessions: { list: h.csList } },
    invoicePayments: { list: h.invPayList }
  }),
  Stripe: class {}
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: h.rpc,
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.fromData(table) }) }) }),
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
    if (fn === 'notificar_staff') return notificarResult();
    return { data: null, error: null };
  });
}
let notificarResult: () => { data: unknown; error: unknown } = () => ({ data: null, error: null });

const ev = (over: Record<string, unknown>) => ({ id: 'evt_1', created: 1_700_000_000, ...over });
const req = () => ({ httpMethod: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}', isBase64Encoded: false } as never);
const call = () => handler(req(), {} as never) as Promise<{ statusCode: number; body: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  claimResult = { id: 'evt_1', estado: 'processing' };
  dispatchResult = { data: { ok: true }, error: null };
  notificarResult = () => ({ data: null, error: null });
  h.fromData = (table: string): unknown => (table === 'tenants' ? { id: 'tenant_1' } : null);
  wireRpc();
  h.csList.mockResolvedValue({ data: [] });
  h.invPayList.mockResolvedValue({ data: [] });
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

  // ── W6-C1 ──────────────────────────────────────────────────────────────────
  it('charge.refunded → dispatcher reembolso con cada refund por su refund.id', async () => {
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunds: { data: [
        { id: 're_1', amount: 20000, currency: 'mxn' }, { id: 're_2', amount: 10000, currency: 'mxn' }
      ] } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    const disp = h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio');
    expect(disp?.[1]).toMatchObject({ p_kind: 'reembolso' });
    expect((disp?.[1] as any).p_args.refunds).toHaveLength(2);
    expect((disp?.[1] as any).p_args.refunds[0].refund_id).toBe('re_1');
  });

  it('charge.dispute.created → dispatcher disputa estado abierta + alerta staff', async () => {
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 50000, currency: 'mxn', status: 'needs_response' } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    const disp = h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio');
    expect(disp?.[1]).toMatchObject({ p_kind: 'disputa' });
    expect((disp?.[1] as any).p_args.estado).toBe('abierta');
    expect(h.rpc.mock.calls.some((c) => c[0] === 'notificar_staff')).toBe(true); // push best-effort
  });

  it('charge.dispute.closed (lost) → dispatcher disputa estado perdida, sin alerta', async () => {
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 50000, currency: 'mxn', status: 'lost' } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    const disp = h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio');
    expect((disp?.[1] as any).p_args.estado).toBe('perdida');
    expect(h.rpc.mock.calls.some((c) => c[0] === 'notificar_staff')).toBe(false);
  });

  it('customer.subscription.updated (active) → sub_estado activa (sin dinero)', async () => {
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active', metadata: { app: 'sala' } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    const disp = h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio');
    expect(disp?.[1]).toMatchObject({ p_kind: 'sub_estado' });
    expect((disp?.[1] as any).p_args.nuevo_status).toBe('activa');
  });

  it('customer.subscription.updated (trialing) → ignorado (estado no forzable)', async () => {
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'trialing', metadata: { app: 'sala' } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(h.rpc.mock.calls.some((c) => c[0] === 'stripe_procesar_socio')).toBe(false);
  });

  it('fallo del push de disputa NO revierte el estado durable (dispatch ya commiteó) → 200', async () => {
    notificarResult = () => { throw new Error('push caído'); };
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.dispute.created',
      data: { object: { id: 'dp_9', charge: 'ch_9', payment_intent: 'pi_9', amount: 50000, currency: 'mxn', status: 'needs_response' } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200); // el push falló pero el evento quedó procesado
    const disp = h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio');
    expect(disp?.[1]).toMatchObject({ p_kind: 'disputa' });
    expect(h.reportar).toHaveBeenCalled(); // el fallo del push se reportó, no se tragó en silencio
    expect(h.rpc.mock.calls.some((c) => c[0] === '_stripe_inbox_failed')).toBe(false); // no se marcó failed
  });

  // ── W6-C1b: el cargo se resuelve por TODAS sus referencias (ch_/pi_/cs_/in_) ──
  it('charge.refunded de una ALTA: manda la Checkout Session (cs_) en refs', async () => {
    h.csList.mockResolvedValue({ data: [{ id: 'cs_live_1' }] });
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunds: { data: [{ id: 're_1', amount: 80000, currency: 'mxn', created: 10 }] } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    const args = (h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio')?.[1] as any).p_args;
    expect(args.refs).toEqual(expect.arrayContaining(['ch_1', 'pi_1', 'cs_live_1']));
    expect(args.refunds[0]).toMatchObject({ refund_id: 're_1', created: 10 });
    expect(h.csList).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 1 }, { stripeAccount: 'acct_1' });
  });

  it('charge.refunded de una RENOVACIÓN: manda la invoice (in_) en refs', async () => {
    h.invPayList.mockResolvedValue({ data: [{ invoice: 'in_9' }] });
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.refunded',
      data: { object: { id: 'ch_2', payment_intent: 'pi_2', refunds: { data: [{ id: 're_2', amount: 1000, currency: 'mxn' }] } } }
    }));
    await call();
    const args = (h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio')?.[1] as any).p_args;
    expect(args.refs).toEqual(expect.arrayContaining(['ch_2', 'pi_2', 'in_9']));
  });

  it('disputa: también resuelve cs_ para encontrar el pago de la alta', async () => {
    h.csList.mockResolvedValue({ data: [{ id: 'cs_live_7' }] });
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.dispute.closed',
      data: { object: { id: 'dp_7', charge: 'ch_7', payment_intent: 'pi_7', amount: 80000, currency: 'mxn', status: 'lost' } }
    }));
    await call();
    const args = (h.rpc.mock.calls.find((c) => c[0] === 'stripe_procesar_socio')?.[1] as any).p_args;
    expect(args.refs).toEqual(expect.arrayContaining(['ch_7', 'pi_7', 'cs_live_7']));
  });

  it('si falla la lectura de referencias → 500 (Stripe reintenta), nada entra al inbox', async () => {
    h.csList.mockRejectedValue(new Error('stripe caído'));
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.refunded',
      data: { object: { id: 'ch_3', payment_intent: 'pi_3', refunds: { data: [{ id: 're_3', amount: 1000, currency: 'mxn' }] } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(500);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('reembolso sin pago interno (sin_pago) → 200 procesado + reportado, no se pierde en silencio', async () => {
    dispatchResult = { data: { ok: true, kind: 'reembolso', sin_pago: true }, error: null };
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.refunded',
      data: { object: { id: 'ch_4', payment_intent: 'pi_4', refunds: { data: [{ id: 're_4', amount: 1000, currency: 'mxn' }] } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(h.reportar).toHaveBeenCalled();
    expect(h.rpc.mock.calls.some((c) => c[0] === '_stripe_inbox_failed')).toBe(false);
  });

  // ── W6-D ─────────────────────────────────────────────────────────────────
  it('refund NUEVO (compensaciones_nuevas) → notifica al staff', async () => {
    dispatchResult = { data: { ok: true, kind: 'reembolso', pago_id: 'pago_1', compensaciones_nuevas: [{ refund_id: 're_1', monto_centavos: 20000 }] }, error: null };
    h.fromData = (table: string) => table === 'pagos' ? { tenant_id: 'tenant_1', usuario_id: 'u1' } : table === 'usuarios' ? { nombre: 'Ana' } : null;
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunds: { data: [{ id: 're_1', amount: 20000, currency: 'mxn' }] } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    const n = h.rpc.mock.calls.find((c) => c[0] === 'notificar_staff');
    expect(n?.[1]).toMatchObject({ p_tipo: 'refund_exitoso', p_tenant_id: 'tenant_1', p_metadata: { usuario_id: 'u1', refund_id: 're_1' } });
  });

  it('replay del mismo refund (compensaciones_nuevas vacío) → NO notifica de nuevo', async () => {
    dispatchResult = { data: { ok: true, kind: 'reembolso', pago_id: 'pago_1', compensaciones_nuevas: [] }, error: null };
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunds: { data: [{ id: 're_1', amount: 20000, currency: 'mxn' }] } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(h.rpc.mock.calls.some((c) => c[0] === 'notificar_staff' && (c[1] as any).p_tipo === 'refund_exitoso')).toBe(false);
  });

  it('disputa_transicion=true + perdida → notifica "contracargo perdido"', async () => {
    dispatchResult = { data: { ok: true, kind: 'disputa', pago_id: 'pago_1', disputa_transicion: true, estado: 'perdida', dispute_id: 'dp_1' }, error: null };
    h.fromData = (table: string) => table === 'pagos' ? { tenant_id: 'tenant_1', usuario_id: 'u1' } : table === 'usuarios' ? { nombre: 'Ana' } : null;
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 50000, currency: 'mxn', status: 'lost' } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    const n = h.rpc.mock.calls.find((c) => c[0] === 'notificar_staff' && (c[1] as any).p_tipo === 'contracargo_resuelto');
    expect(n?.[1]).toMatchObject({ p_metadata: { usuario_id: 'u1', dispute_id: 'dp_1', estado: 'perdida' } });
  });

  it('disputa_transicion=false (replay del mismo estado) → NO notifica resolución de nuevo', async () => {
    dispatchResult = { data: { ok: true, kind: 'disputa', pago_id: 'pago_1', disputa_transicion: false, estado: 'perdida', dispute_id: 'dp_1' }, error: null };
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 50000, currency: 'mxn', status: 'lost' } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(h.rpc.mock.calls.some((c) => c[0] === 'notificar_staff' && (c[1] as any).p_tipo === 'contracargo_resuelto')).toBe(false);
  });

  it('fallo de notificar_staff (refund) NO rompe el procesamiento económico → sigue 200, se reporta', async () => {
    dispatchResult = { data: { ok: true, kind: 'reembolso', pago_id: 'pago_1', compensaciones_nuevas: [{ refund_id: 're_1', monto_centavos: 20000 }] }, error: null };
    h.fromData = (table: string) => table === 'pagos' ? { tenant_id: 'tenant_1', usuario_id: 'u1' } : table === 'usuarios' ? { nombre: 'Ana' } : null;
    notificarResult = () => ({ data: null, error: { message: 'boom' } });
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunds: { data: [{ id: 're_1', amount: 20000, currency: 'mxn' }] } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200); // la compensación YA commiteó en el dispatcher; el aviso es best-effort
    expect(h.rpc.mock.calls.some((c) => c[0] === '_stripe_inbox_failed')).toBe(false);
  });

  it('sin pago_id resoluble (datosDelPago falla) → no notifica, no revienta', async () => {
    dispatchResult = { data: { ok: true, kind: 'reembolso', pago_id: null, compensaciones_nuevas: [{ refund_id: 're_1', monto_centavos: 20000 }] }, error: null };
    h.constructEvent.mockImplementation(() => ev({
      account: 'acct_1', type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunds: { data: [{ id: 're_1', amount: 20000, currency: 'mxn' }] } } }
    }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(h.rpc.mock.calls.some((c) => c[0] === 'notificar_staff' && (c[1] as any).p_tipo === 'refund_exitoso')).toBe(false);
  });
});
