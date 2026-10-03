// ============================================================================
// W6-C2 — motor canónico de reconciliación Stripe ↔ interno. READ-ONLY, PURO.
// ----------------------------------------------------------------------------
// Una sola lógica de comparación (payment-scoped). Socio/membresía NO duplica
// reglas: resuelve pagos y agrega resultados de ESTE motor. No muta nada.
// ============================================================================

export type LookupStatus = 'OK' | 'NOT_FOUND' | 'NOT_ACCESSIBLE' | 'UNKNOWN';

export type ReconResult =
  | 'MATCH' | 'EXPLAINED_DIFFERENCE'
  | 'MISSING_INTERNAL' | 'MISSING_STRIPE'
  | 'AMOUNT_MISMATCH' | 'REFUND_MISMATCH' | 'DISPUTE_MISMATCH'
  | 'OWNERSHIP_MISMATCH' | 'STATE_MISMATCH'
  | 'INSUFFICIENT_EVIDENCE' | 'MANUAL_REVIEW'
  | 'NOT_FOUND' | 'NOT_ACCESSIBLE' | 'UNKNOWN';

/** Vista económica normalizada (interna o de Stripe), en centavos. */
export interface EconView {
  gross: number;           // cobro bruto (positivo)
  refunded: number;        // reembolsado (positivo)
  disputed_lost: number;   // perdido por contracargo (positivo)
  net: number;             // gross - refunded - disputed_lost
  currency: string;
  state: string;           // 'succeeded' | 'partially_refunded' | 'refunded' | 'disputed_lost'
}

export interface Evidence {
  pendingInbox?: boolean;  // hay evento de inbox relevante aún no 'processed'
  recent?: boolean;        // el objeto Stripe es muy reciente (ventana de gracia)
}

export interface Recon {
  result: ReconResult;
  discrepancies: string[];
  internal: EconView | null;
  stripe: EconView | null;
}

// ── Routing de pagos.referencia por prefijo real (nunca asumir PI) ──────────
export type RefKind = 'session' | 'invoice' | 'payment_intent' | 'refund' | 'dispute' | 'unknown';
export function routeReferencia(ref: string | null | undefined): RefKind {
  if (!ref) return 'unknown';
  if (ref.startsWith('cs_')) return 'session';
  if (ref.startsWith('in_')) return 'invoice';
  if (ref.startsWith('pi_')) return 'payment_intent';
  if (ref.startsWith('re_')) return 'refund';
  if (ref.startsWith('dp_')) return 'dispute';
  return 'unknown';
}

// ── Vista económica INTERNA desde el grupo de cargo (positivo + negativos) ──
interface PagoRow { concepto: string; monto_centavos: number; moneda: string; referencia: string | null; revierte_pago_id: string | null; }
export function internalEconView(group: PagoRow[]): EconView | null {
  const pos = group.find((p) => p.concepto !== 'reembolso' && p.monto_centavos > 0);
  if (!pos) return null;
  const gross = pos.monto_centavos;
  let refunded = 0, disputed_lost = 0;
  for (const p of group) {
    if (p.concepto !== 'reembolso' || p.monto_centavos >= 0) continue;
    const amt = Math.abs(p.monto_centavos);
    if ((p.referencia ?? '').startsWith('dp_')) disputed_lost += amt;
    else refunded += amt;  // re_ u otros reembolsos
  }
  const net = gross - refunded - disputed_lost;
  return { gross, refunded, disputed_lost, net, currency: pos.moneda, state: deriveState(gross, refunded, disputed_lost) };
}

export function deriveState(gross: number, refunded: number, disputed_lost: number): string {
  if (disputed_lost > 0) return 'disputed_lost';
  if (refunded >= gross && gross > 0) return 'refunded';
  if (refunded > 0) return 'partially_refunded';
  return 'succeeded';
}

// ── Comparación canónica de UN cargo ────────────────────────────────────────
export function reconcileOne(input: {
  internal: EconView | null;
  stripe: { status: LookupStatus; view: EconView | null; ownershipOk: boolean };
  evidence?: Evidence;
}): Recon {
  const { internal, stripe, evidence } = input;
  const mk = (result: ReconResult, discrepancies: string[] = []): Recon =>
    ({ result, discrepancies, internal, stripe: stripe.view });

  // 1) estado del lookup: un fallo NUNCA es "no existe" salvo NOT_FOUND autoritativo.
  if (stripe.status === 'NOT_ACCESSIBLE') return mk('NOT_ACCESSIBLE');
  if (stripe.status === 'UNKNOWN') return mk('UNKNOWN');
  if (stripe.status === 'NOT_FOUND') return mk(internal ? 'MISSING_STRIPE' : 'NOT_FOUND');

  // 2) OK → ownership inequívoco primero.
  if (!stripe.ownershipOk) return mk('OWNERSHIP_MISMATCH');
  if (!internal && stripe.view) return mk('MISSING_INTERNAL');
  if (internal && !stripe.view) return mk('INSUFFICIENT_EVIDENCE');
  if (!internal || !stripe.view) return mk('INSUFFICIENT_EVIDENCE');

  // 3) comparación de dinero + estado.
  const i = internal, s = stripe.view;
  const disc: string[] = [];
  if (i.currency.toLowerCase() !== s.currency.toLowerCase()) disc.push('currency');
  if (i.gross !== s.gross) disc.push('gross');
  if (i.refunded !== s.refunded) disc.push('refunded');
  if (i.disputed_lost !== s.disputed_lost) disc.push('disputed_lost');
  const stateDiff = i.state !== s.state;

  if (disc.length === 0 && !stateDiff) return mk('MATCH');

  // diferencia transitoria explicable (webhook en vuelo / objeto recién creado).
  const explainable = Boolean(evidence?.pendingInbox || evidence?.recent);
  if (explainable) return mk('EXPLAINED_DIFFERENCE', disc.length ? disc : ['state']);

  // precedencia: dinero antes que estado; no colapsar discrepancias distintas.
  if (disc.includes('currency') || disc.includes('gross')) return mk('AMOUNT_MISMATCH', disc);
  if (disc.includes('refunded')) return mk('REFUND_MISMATCH', disc);
  if (disc.includes('disputed_lost')) return mk('DISPUTE_MISMATCH', disc);
  if (stateDiff) return mk('STATE_MISMATCH', ['state']);
  return mk('MANUAL_REVIEW', disc);
}

// ── Agregado socio/membresía (composición, SIN reglas nuevas) ───────────────
export interface AggregateSummary {
  total_payments: number;
  match: number;
  explained_differences: number;
  mismatches: number;
  manual_review: number;
  unknown: number;
  overall: 'MATCH' | 'ATTENTION' | 'UNKNOWN';
}

const MISMATCH_SET: ReconResult[] = [
  'MISSING_INTERNAL','MISSING_STRIPE','AMOUNT_MISMATCH','REFUND_MISMATCH',
  'DISPUTE_MISMATCH','OWNERSHIP_MISMATCH','STATE_MISMATCH'
];
const UNKNOWN_SET: ReconResult[] = ['NOT_ACCESSIBLE','UNKNOWN','NOT_FOUND','INSUFFICIENT_EVIDENCE'];

export function aggregate(results: Recon[]): AggregateSummary {
  const s: AggregateSummary = {
    total_payments: results.length, match: 0, explained_differences: 0,
    mismatches: 0, manual_review: 0, unknown: 0, overall: 'MATCH'
  };
  for (const r of results) {
    if (r.result === 'MATCH') s.match++;
    else if (r.result === 'EXPLAINED_DIFFERENCE') s.explained_differences++;
    else if (r.result === 'MANUAL_REVIEW') s.manual_review++;
    else if (MISMATCH_SET.includes(r.result)) s.mismatches++;
    else if (UNKNOWN_SET.includes(r.result)) s.unknown++;
  }
  // El resumen NUNCA esconde discrepancias: cualquier mismatch/manual → ATTENTION;
  // cualquier unknown (sin mismatch) → UNKNOWN; todo match/explained → MATCH.
  if (s.mismatches > 0 || s.manual_review > 0) s.overall = 'ATTENTION';
  else if (s.unknown > 0) s.overall = 'UNKNOWN';
  else s.overall = 'MATCH';
  return s;
}
