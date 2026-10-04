import { describe, it, expect } from 'vitest';
import {
  reconcileOne, internalEconView, routeReferencia, aggregate, deriveState,
  type EconView, type Recon, type LookupStatus
} from '../_lib/reconcile';

const ev = (gross: number, refunded = 0, disputed_lost = 0, currency = 'mxn'): EconView =>
  ({ gross, refunded, disputed_lost, net: gross - refunded - disputed_lost, currency, state: deriveState(gross, refunded, disputed_lost) });
const okS = (view: EconView | null, ownershipOk = true) => ({ status: 'OK' as LookupStatus, view, ownershipOk });
const one = (internal: EconView | null, stripe: ReturnType<typeof okS>, evidence?: { pendingInbox?: boolean; recent?: boolean }) =>
  reconcileOne({ internal, stripe, evidence });
const pago = (concepto: string, monto: number, referencia: string | null, revierte: string | null = null) =>
  ({ concepto, monto_centavos: monto, moneda: 'MXN', referencia, revierte_pago_id: revierte });

describe('W6-C2 — motor payment-scoped (puro, read-only)', () => {
  it('1 exact match', () => { expect(one(ev(50000), okS(ev(50000))).result).toBe('MATCH'); });

  it('2 partial refund que coincide → MATCH; que difiere → REFUND_MISMATCH', () => {
    expect(one(ev(50000, 20000), okS(ev(50000, 20000))).result).toBe('MATCH');
    expect(one(ev(50000, 20000), okS(ev(50000, 10000))).result).toBe('REFUND_MISMATCH');
  });

  it('3 múltiples refunds: internalEconView suma los negativos', () => {
    const v = internalEconView([pago('plan', 50000, 'pi_1'), pago('reembolso', -20000, 're_1', 'x'), pago('reembolso', -10000, 're_2', 'x')]);
    expect(v?.refunded).toBe(30000); expect(v?.net).toBe(20000); expect(v?.state).toBe('partially_refunded');
  });

  it('4 dispute open: no cambia dinero → MATCH', () => { expect(one(ev(50000), okS(ev(50000))).result).toBe('MATCH'); });

  it('5 dispute lost coincide → MATCH; difiere → DISPUTE_MISMATCH', () => {
    expect(one(ev(50000, 0, 50000), okS(ev(50000, 0, 50000))).result).toBe('MATCH');
    expect(one(ev(50000, 0, 0), okS(ev(50000, 0, 50000))).result).toBe('DISPUTE_MISMATCH');
  });

  it('6 dispute won: sin compensación → MATCH', () => { expect(one(ev(50000), okS(ev(50000))).result).toBe('MATCH'); });

  it('7 refund + dispute mismo pago: suma ambos, net correcto', () => {
    const v = internalEconView([pago('plan', 50000, 'pi_1'), pago('reembolso', -20000, 're_1', 'x'), pago('reembolso', -30000, 'dp_d1', 'x')]);
    expect(v?.refunded).toBe(20000); expect(v?.disputed_lost).toBe(30000); expect(v?.net).toBe(0);
    expect(one(v, okS(ev(50000, 20000, 30000))).result).toBe('MATCH');
  });

  it('27 plan + inscripción en la MISMA referencia: el bruto interno es la suma → MATCH (sin falso mismatch)', () => {
    const v = internalEconView([pago('plan', 50000, 'cs_1'), pago('inscripcion', 30000, 'cs_1')]);
    expect(v?.gross).toBe(80000);
    expect(one(v, okS(ev(80000))).result).toBe('MATCH');
    // y si Stripe cobró otra cosa, sí se reporta
    expect(one(v, okS(ev(50000))).result).toBe('AMOUNT_MISMATCH');
  });

  it('28 C1b: refund total repartido en dos filas (re_x y re_x#2) → C2 ve MATCH', () => {
    const v = internalEconView([
      pago('plan', 50000, 'cs_1'), pago('inscripcion', 30000, 'cs_1'),
      pago('reembolso', -50000, 're_x', 'plan'), pago('reembolso', -30000, 're_x#2', 'insc')
    ]);
    expect(v).toMatchObject({ gross: 80000, refunded: 80000, disputed_lost: 0, net: 0, state: 'refunded' });
    expect(one(v, okS(ev(80000, 80000))).result).toBe('MATCH');
  });

  it('29 C1b: refund + contracargo partido (dp_x#2 sigue contando como contracargo) → MATCH', () => {
    const v = internalEconView([
      pago('plan', 50000, 'cs_1'), pago('inscripcion', 30000, 'cs_1'),
      pago('reembolso', -20000, 're_y', 'plan'),
      pago('reembolso', -30000, 'dp_z', 'plan'), pago('reembolso', -30000, 'dp_z#2', 'insc')
    ]);
    expect(v).toMatchObject({ refunded: 20000, disputed_lost: 60000, net: 0 });
    expect(one(v, okS(ev(80000, 20000, 60000))).result).toBe('MATCH');
  });

  it('8 missing internal → MISSING_INTERNAL', () => { expect(one(null, okS(ev(50000))).result).toBe('MISSING_INTERNAL'); });

  it('9 inaccessible Stripe → NOT_ACCESSIBLE (no MISSING_STRIPE)', () => {
    expect(one(ev(50000), { status: 'NOT_ACCESSIBLE', view: null, ownershipOk: true }).result).toBe('NOT_ACCESSIBLE');
  });

  it('10 wrong connected account → OWNERSHIP_MISMATCH', () => {
    expect(one(ev(50000), okS(ev(50000), false)).result).toBe('OWNERSHIP_MISMATCH');
  });

  it('11 amount mismatch → AMOUNT_MISMATCH', () => { expect(one(ev(50000), okS(ev(60000))).result).toBe('AMOUNT_MISMATCH'); });

  it('12 currency mismatch → AMOUNT_MISMATCH con discrepancia currency', () => {
    const r = one(ev(50000, 0, 0, 'mxn'), okS(ev(50000, 0, 0, 'usd')));
    expect(r.result).toBe('AMOUNT_MISMATCH'); expect(r.discrepancies).toContain('currency');
  });

  it('13 subscription/state mismatch con dinero igual → STATE_MISMATCH', () => {
    const i = ev(50000); const s = { ...ev(50000), state: 'refunded' };
    expect(one(i, okS(s)).result).toBe('STATE_MISMATCH');
  });

  it('14 evidencia de webhook duplicada NO doble-cuenta (econview desde pagos, no eventos)', () => {
    // dos eventos de inbox no cambian el econview; solo cuentan los pagos.
    const v = internalEconView([pago('plan', 50000, 'pi_1'), pago('reembolso', -20000, 're_1', 'x')]);
    expect(v?.refunded).toBe(20000);
  });

  it('15 Stripe adelante (webhook en vuelo) → EXPLAINED_DIFFERENCE', () => {
    expect(one(ev(50000, 0), okS(ev(50000, 20000)), { pendingInbox: true }).result).toBe('EXPLAINED_DIFFERENCE');
  });

  it('16 interno adelante explicable (objeto reciente) → EXPLAINED_DIFFERENCE', () => {
    expect(one(ev(50000, 20000), okS(ev(50000, 0)), { recent: true }).result).toBe('EXPLAINED_DIFFERENCE');
  });

  it('19 Stripe timeout → UNKNOWN', () => {
    expect(one(ev(50000), { status: 'UNKNOWN', view: null, ownershipOk: true }).result).toBe('UNKNOWN');
  });

  it('20 reconciliación repetida es pura/determinista (cero efectos)', () => {
    const a = one(ev(50000, 20000), okS(ev(50000, 20000)));
    const b = one(ev(50000, 20000), okS(ev(50000, 20000)));
    expect(a).toEqual(b);
  });

  it('NOT_FOUND autoritativo: interno presente → MISSING_STRIPE; sin interno → NOT_FOUND', () => {
    expect(one(ev(50000), { status: 'NOT_FOUND', view: null, ownershipOk: true }).result).toBe('MISSING_STRIPE');
    expect(one(null, { status: 'NOT_FOUND', view: null, ownershipOk: true }).result).toBe('NOT_FOUND');
  });

  it('25 routing cs_/in_/pi_/re_/dp_/desconocido', () => {
    expect(routeReferencia('cs_1')).toBe('session');
    expect(routeReferencia('in_1')).toBe('invoice');
    expect(routeReferencia('pi_1')).toBe('payment_intent');
    expect(routeReferencia('re_1')).toBe('refund');
    expect(routeReferencia('dp_1')).toBe('dispute');
    expect(routeReferencia('folio-123')).toBe('unknown');
    expect(routeReferencia(null)).toBe('unknown');
  });
});

describe('W6-C2 — agregado socio/membresía (composición, nunca oculta)', () => {
  const R = (result: Recon['result']): Recon => ({ result, discrepancies: [], internal: null, stripe: null });

  it('21 socio con todos MATCH → overall MATCH', () => {
    const s = aggregate([R('MATCH'), R('MATCH'), R('MATCH')]);
    expect(s).toMatchObject({ total_payments: 3, match: 3, overall: 'MATCH' });
  });

  it('22 socio con MATCH + mismatch → overall ATTENTION (no se oculta)', () => {
    const s = aggregate([R('MATCH'), R('AMOUNT_MISMATCH'), R('MATCH')]);
    expect(s.mismatches).toBe(1); expect(s.overall).toBe('ATTENTION');
  });

  it('23 membresía con UNKNOWN en un pago → overall UNKNOWN (no MATCH)', () => {
    const s = aggregate([R('MATCH'), R('UNKNOWN')]);
    expect(s.unknown).toBe(1); expect(s.overall).toBe('UNKNOWN');
  });

  it('24 el agregado nunca presenta MATCH si hay cualquier discrepancia', () => {
    expect(aggregate([R('MATCH'), R('MANUAL_REVIEW')]).overall).toBe('ATTENTION');
    expect(aggregate([R('EXPLAINED_DIFFERENCE'), R('MATCH')]).overall).toBe('MATCH'); // explained no es discrepancia abierta
  });
});
