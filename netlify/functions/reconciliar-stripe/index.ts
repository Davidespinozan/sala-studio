import ws from 'ws';
if (!globalThis.WebSocket) { (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws; }

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import {
  reconcileOne, internalEconView, routeReferencia, aggregate,
  type EconView, type LookupStatus, type Recon
} from '../_lib/reconcile';

/**
 * POST /reconciliar-stripe — W6-C2. Reconciliación ON-DEMAND, READ-ONLY, admin,
 * tenant-scoped. Compara la verdad económica INTERNA (RPC) contra Stripe. NO muta
 * nada (ni Stripe ni DB). Un solo motor payment-scoped; socio/membresía agrega.
 *
 * Body: { sujeto: 'pago'|'membresia'|'socio', id: <uuid interno> }
 * Nunca acepta un Stripe ID crudo como sujeto: el ownership se resuelve SOLO por
 * id interno vía la RPC (que gatea auth+admin+tenant).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRACE_MS = 10 * 60 * 1000; // objeto "reciente" → diferencia posiblemente transitoria

interface PagoRow {
  id: string; usuario_id: string; membresia_id: string | null; concepto: string;
  monto_centavos: number; moneda: string; metodo: string; referencia: string | null;
  revierte_pago_id: string | null; created_at: string;
}

/** Mapea un error de Stripe a un estado de lookup. NUNCA "no existe" salvo resource_missing. */
function lookupStatusFromError(e: any): LookupStatus {
  const code = e?.code || e?.raw?.code;
  const type = e?.type || e?.raw?.type;
  const sc = e?.statusCode ?? e?.raw?.statusCode;
  if (code === 'resource_missing') return 'NOT_FOUND';
  if (type === 'StripeAuthenticationError' || type === 'StripePermissionError' || sc === 401 || sc === 403) return 'NOT_ACCESSIBLE';
  return 'UNKNOWN'; // timeout, rate_limit, conexión, lo que sea → fail-closed
}

/** Recupera el objeto Stripe del cargo (read-only, en contexto Connect) y lo normaliza. */
async function stripeEconView(
  stripe: ReturnType<typeof getStripe>, ref: string, acct: string | null, expectedCustomers: string[]
): Promise<{ status: LookupStatus; view: EconView | null; ownershipOk: boolean; createdMs: number | null }> {
  if (!acct) return { status: 'NOT_ACCESSIBLE', view: null, ownershipOk: false, createdMs: null };
  const sa = { stripeAccount: acct };
  const kind = routeReferencia(ref);
  try {
    let charge: any = null; let gross = 0; let currency = ''; let customer: string | null = null; let createdMs: number | null = null;
    if (kind === 'payment_intent') {
      const pi: any = await stripe.paymentIntents.retrieve(ref, { expand: ['latest_charge'] }, sa);
      charge = pi.latest_charge; gross = pi.amount ?? 0; currency = pi.currency ?? ''; customer = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? null; createdMs = (pi.created ?? 0) * 1000;
    } else if (kind === 'invoice') {
      const inv: any = await stripe.invoices.retrieve(ref, { expand: ['charge'] }, sa);
      charge = inv.charge; gross = inv.amount_paid ?? 0; currency = inv.currency ?? ''; customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id ?? null; createdMs = (inv.created ?? 0) * 1000;
    } else if (kind === 'session') {
      const cs: any = await stripe.checkout.sessions.retrieve(ref, { expand: ['payment_intent.latest_charge'] }, sa);
      const pi: any = cs.payment_intent; charge = pi?.latest_charge ?? null;
      gross = cs.amount_total ?? pi?.amount ?? 0; currency = cs.currency ?? pi?.currency ?? ''; customer = typeof cs.customer === 'string' ? cs.customer : cs.customer?.id ?? null; createdMs = (cs.created ?? 0) * 1000;
    } else {
      return { status: 'NOT_FOUND', view: null, ownershipOk: true, createdMs: null }; // referencia no es un cargo resoluble
    }
    if (typeof charge === 'string') charge = await stripe.charges.retrieve(charge, { expand: ['refunds'] }, sa);
    const refunded = charge?.amount_refunded ?? 0;
    let disputed_lost = 0;
    if (charge?.disputed) {
      const disputes: any = await stripe.disputes.list({ charge: charge.id, limit: 10 }, sa);
      for (const d of disputes.data ?? []) if (d.status === 'lost') disputed_lost += d.amount ?? 0;
    }
    const net = gross - refunded - disputed_lost;
    const state = disputed_lost > 0 ? 'disputed_lost' : refunded >= gross && gross > 0 ? 'refunded' : refunded > 0 ? 'partially_refunded' : 'succeeded';
    // ownership: el retrieve ya ocurrió en la cuenta del tenant; además, si el
    // objeto trae customer y NO coincide con los del socio esperado, se marca mismatch.
    const ownershipOk = !customer || expectedCustomers.length === 0 || expectedCustomers.includes(customer);
    return { status: 'OK', view: { gross, refunded, disputed_lost, net, currency, state }, ownershipOk, createdMs };
  } catch (e) {
    return { status: lookupStatusFromError(e), view: null, ownershipOk: true, createdMs: null };
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');
  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body = JSON.parse(event.body || '{}') as { sujeto?: string; id?: string; tenant_id?: string };
    const sujeto = body.sujeto ?? '';
    const id = (body.id ?? '').trim();
    if (!['pago', 'membresia', 'socio'].includes(sujeto)) return badRequest('Sujeto inválido');
    // SOLO id interno (uuid). Un Stripe ID crudo (acct_/cus_/sub_/pi_/…) jamás entra.
    if (!UUID_RE.test(id)) return badRequest('Id interno inválido (se requiere un uuid del tenant)');

    // Verdad interna vía RPC en el contexto del usuario → gatea auth+admin+tenant.
    // Multi-gym: el gym ACTIVO del admin viaja como x-tenant-id. No da permisos:
    // la base solo lo honra si el usuario tiene ficha en ese gym (si no, cae a su
    // ficha por defecto) y la RPC igual exige admin + ownership.
    const tenantHdr = typeof body.tenant_id === 'string' && UUID_RE.test(body.tenant_id) ? body.tenant_id : null;
    const asUser = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('VITE_SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: `Bearer ${userToken}`, ...(tenantHdr ? { 'x-tenant-id': tenantHdr } : {}) } },
      auth: { persistSession: false }
    });
    const { data: bundle, error } = await asUser.rpc('reconciliar_verdad_interna', { p_sujeto: sujeto, p_id: id });
    if (error) {
      const msg = (error as { message?: string }).message ?? String(error);
      if (msg.includes('RECON_NO_AUTH')) return unauthorized('No autenticado');
      if (msg.includes('RECON_NO_ADMIN')) return forbidden('Solo un administrador puede reconciliar');
      if (msg.includes('RECON_NOT_FOUND')) return { statusCode: 404, body: JSON.stringify({ error: 'No encontrado en tu gym' }) };
      return serverError('No se pudo leer la verdad interna');
    }

    const b = bundle as any;
    const acct: string | null = b.stripe_account_id ?? null;
    const pagos: PagoRow[] = b.pagos ?? [];
    const expectedCustomers: string[] = [
      ...((b.socios ?? []).map((s: any) => s.stripe_customer_id)),
      ...((b.membresias ?? []).map((m: any) => m.stripe_customer_id))
    ].filter(Boolean);
    const inbox: Array<{ object_id: string; estado: string }> = b.inbox ?? [];
    const disputas: Array<{ pago_id: string | null; estado: string; monto_centavos: number | null }> = b.disputas ?? [];

    const stripe = getStripe();
    const nowMs = Date.now();

    // Agrupar por OBJETO Stripe: todos los positivos que comparten referencia
    // (plan + inscripción de una misma sesión) + los negativos que revierten a
    // cualquiera de ellos. Un positivo sin referencia es su propio grupo.
    const positivos = pagos.filter((p) => p.concepto !== 'reembolso' && p.monto_centavos > 0);
    const porObjeto = new Map<string, PagoRow[]>();
    for (const pos of positivos) {
      const clave = pos.referencia ? `ref:${pos.referencia}` : `pago:${pos.id}`;
      porObjeto.set(clave, [...(porObjeto.get(clave) ?? []), pos]);
    }
    const grupos = [...porObjeto.values()].map((poss) => {
      const ids = new Set(poss.map((p) => p.id));
      return [...poss, ...pagos.filter((p) => p.revierte_pago_id != null && ids.has(p.revierte_pago_id))];
    });

    const detalles: Array<Record<string, unknown>> = [];
    const recons: Recon[] = [];
    for (const grupo of grupos) {
      const pos = grupo[0];
      const internal = internalEconView(grupo.map((p) => ({
        concepto: p.concepto, monto_centavos: p.monto_centavos, moneda: p.moneda,
        referencia: p.referencia, revierte_pago_id: p.revierte_pago_id
      })));
      const ref = pos.referencia;
      let s: { status: LookupStatus; view: EconView | null; ownershipOk: boolean; createdMs: number | null };
      if (!ref || routeReferencia(ref) === 'unknown' || pos.metodo !== 'stripe') {
        s = { status: 'NOT_FOUND', view: null, ownershipOk: true, createdMs: null };
      } else {
        s = await stripeEconView(stripe, ref, acct, expectedCustomers);
      }
      // evidencia: evento de inbox de este objeto aún no 'processed' → transitorio;
      // o el objeto/pago es muy reciente (ventana de gracia).
      const pendingInbox = inbox.some((i) => i.object_id === ref && i.estado !== 'processed');
      const recent = (s.createdMs != null && nowMs - s.createdMs < GRACE_MS) ||
                     (nowMs - new Date(pos.created_at).getTime() < GRACE_MS);
      const r = reconcileOne({ internal, stripe: { status: s.status, view: s.view, ownershipOk: s.ownershipOk }, evidence: { pendingInbox, recent } });
      recons.push(r);
      detalles.push({
        pago_id: pos.id, referencia: ref, kind: routeReferencia(ref),
        result: r.result, discrepancies: r.discrepancies,
        internal: r.internal, stripe: r.stripe,
        pago_ids: grupo.filter((p) => p.concepto !== 'reembolso').map((p) => p.id),
        disputas: disputas.filter((d) => d.pago_id != null && grupo.some((p) => p.id === d.pago_id)),
        evidence: { pendingInbox, recent }
      });
    }

    const resp: Record<string, unknown> = {
      sujeto, id, tenant_id: b.tenant_id, stripe_charges_enabled: b.stripe_charges_enabled,
      consultado_en: new Date().toISOString(),
      detalles
    };
    if (sujeto !== 'pago') resp.resumen = aggregate(recons);
    else resp.result = detalles[0]?.result ?? 'INSUFFICIENT_EVIDENCE';
    return ok(resp);
  } catch (err) {
    console.error('[reconciliar-stripe]', err instanceof Error ? err.message : err);
    return serverError('No se pudo reconciliar');
  }
};
