import ws from 'ws';
// supabase-js arranca Realtime aunque no lo usemos; en Node <22 no hay WebSocket
// global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { getOrCreateSocioCustomer } from '../_lib/connectBilling';

/**
 * POST /comprar-producto — Flujo 2 (Connect): el SOCIO compra de la tienda
 * desde su app, con la tarjeta que ya tiene guardada en el gym.
 * Auth: Bearer JWT del socio.
 * Body: { sucursal_id?, items:[{producto_id,cantidad}], entrega_tipo, entrega_ubicacion? }
 *
 * Reglas (decididas con David):
 *   1. Sin tarjeta guardada → NO cobra: devuelve { paid:false, reason:'sin_tarjeta' }
 *      (la app le ofrece agregar una).
 *   2. El reembolso es cosa del staff (acá no se reembolsa por gusto).
 *   3. Oversell BLOQUEADO: la venta online no se lleva el producto en el momento,
 *      así que no se vende lo que no hay (lo garantiza registrar_venta_online, y
 *      si saltara DESPUÉS de cobrar, se reembolsa en el acto).
 *   4. Socio suspendido/cancelado/revocado → no compra.
 *
 * Orden seguro: cobrar → registrar. Si el registro falla tras un cobro OK, se
 * reembolsa el PaymentIntent (no dejamos dinero cobrado sin venta).
 *
 * Demo → pago SIMULADO (misma idea que la membresía en demo): registra sin tocar
 * Stripe, para que el prospecto vea el flujo completo.
 */

const DEMO_TENANT_SLUG = 'healthyspace';
const STATUS_SIN_ACCESO = ['revocado', 'suspendido', 'cancelado'];
const TIPOS_ENTREGA = ['recepcion', 'tienda', 'llevar'];

interface ItemIn {
  producto_id?: string;
  cantidad?: number;
}
interface Body {
  sucursal_id?: string | null;
  items?: ItemIn[];
  entrega_tipo?: string;
  entrega_ubicacion?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');

    // Saneo del carrito: items válidos (producto + cantidad entera > 0).
    const items = (body.items ?? [])
      .map((it) => ({ producto_id: String(it.producto_id ?? ''), cantidad: Math.floor(Number(it.cantidad) || 0) }))
      .filter((it) => it.producto_id && it.cantidad > 0);
    if (items.length === 0) return badRequest('El carrito está vacío');

    const entregaTipo = body.entrega_tipo ?? 'recepcion';
    if (!TIPOS_ENTREGA.includes(entregaTipo)) return badRequest('Entrega inválida');
    const entregaUbicacion =
      entregaTipo === 'llevar' ? (body.entrega_ubicacion?.trim() || null) : null;
    if (entregaTipo === 'llevar' && !entregaUbicacion) return badRequest('Falta dónde llevarlo');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // 1) Identificar al socio con su propio token (solo columnas GRANTeadas a
    //    authenticated; status/stripe_customer_id se leen abajo con service_role).
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: socio, error: socioErr } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (socioErr) console.error('[comprar-producto] socio:', socioErr.message);
    if (!socio) return forbidden('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un socio compra desde la app');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Columnas privadas del socio (solo service_role).
    const { data: privados } = await admin
      .from('usuarios')
      .select('status, stripe_customer_id')
      .eq('id', socio.id)
      .maybeSingle();
    const status = (privados?.status as string | null) ?? null;
    const stripeCustomerId = (privados?.stripe_customer_id as string | null) ?? null;
    // Regla 4: acceso retirado → no compra.
    if (status && STATUS_SIN_ACCESO.includes(status)) {
      return ok({ paid: false, reason: 'suspendido' });
    }

    // 2) Tenant: demo?, módulo y venta-a-socio prendidos, cuenta conectada.
    const { data: tenant } = await admin
      .from('tenants')
      .select('slug, config, stripe_account_id, stripe_charges_enabled')
      .eq('id', socio.tenant_id)
      .maybeSingle();
    const config = (tenant?.config ?? {}) as Record<string, any>;
    const moduloOn = config?.modulos?.tienda === true;
    const ventaSocioOn = config?.tienda?.venta_socio === true;
    if (!moduloOn || !ventaSocioOn) {
      return ok({ paid: false, reason: 'no_disponible' });
    }

    // La entrega en 'tienda'/'llevar' solo si el gym la habilitó (la de recepción
    // es el fallback siempre disponible).
    const entregaCfg = (config?.tienda?.entrega ?? {}) as Record<string, unknown>;
    const entregaDefinida = 'recepcion' in entregaCfg || 'tienda' in entregaCfg || 'llevar' in entregaCfg;
    const entregaHabilitada =
      entregaTipo === 'recepcion'
        ? (entregaDefinida ? entregaCfg.recepcion === true : true)
        : entregaCfg[entregaTipo] === true;
    if (!entregaHabilitada) return badRequest('Esa forma de entrega no está disponible');

    // Sucursal (opcional): si viene, tiene que ser del gym.
    const sucursalId = body.sucursal_id ?? null;
    if (sucursalId) {
      const { data: suc } = await admin
        .from('sucursales')
        .select('id, tenant_id')
        .eq('id', sucursalId)
        .maybeSingle();
      if (!suc || suc.tenant_id !== socio.tenant_id) return badRequest('Sucursal inválida');
    }

    const itemsJson = items.map((it) => ({ producto_id: it.producto_id, cantidad: it.cantidad }));

    // ── DEMO: pago simulado → registrar directo (sin Stripe). ──
    if (tenant?.slug === DEMO_TENANT_SLUG) {
      const ref = `demo_${socio.id}_${Date.now()}`;
      const { data: result, error: rpcErr } = await admin.rpc('registrar_venta_online', {
        p_tenant_id: socio.tenant_id,
        p_usuario_id: socio.id,
        p_sucursal_id: sucursalId,
        p_items: itemsJson,
        p_referencia: ref,
        p_entrega_tipo: entregaTipo,
        p_entrega_ubicacion: entregaUbicacion
      });
      if (rpcErr) return ok({ paid: false, reason: motivoRpc(rpcErr.message) });
      return ok({ paid: true, demo: true, ...(result as object) });
    }

    // ── TENANT REAL — Connect direct charge, off_session ──
    if (!process.env.STRIPE_SECRET_KEY) return ok({ paid: false, reason: 'stripe_pendiente' });
    if (!tenant?.stripe_account_id || tenant.stripe_charges_enabled !== true) {
      return ok({ paid: false, reason: 'cobros_no_activos' });
    }
    const acct = tenant.stripe_account_id;
    const stripe = getStripe();

    // Customer del socio en la cuenta conectada. Sin customer real todavía → no
    // hay tarjeta guardada.
    if (!stripeCustomerId || stripeCustomerId.startsWith('mock_')) {
      return ok({ paid: false, reason: 'sin_tarjeta' });
    }
    const customerId = await getOrCreateSocioCustomer(
      stripe,
      admin,
      { id: socio.id, email: authUser.email ?? null, stripe_customer_id: stripeCustomerId },
      acct
    );

    // Tarjeta con la que se cobra: la default del customer, o la única que tenga.
    const cust = (await stripe.customers.retrieve(customerId, {}, { stripeAccount: acct })) as any;
    let pmId: string | null = null;
    const defaultPm = cust?.invoice_settings?.default_payment_method;
    if (defaultPm) {
      pmId = typeof defaultPm === 'string' ? defaultPm : defaultPm.id;
    } else {
      const list = await stripe.paymentMethods.list(
        { customer: customerId, type: 'card', limit: 1 },
        { stripeAccount: acct }
      );
      pmId = list.data[0]?.id ?? null;
    }
    // Regla 1: sin tarjeta → no cobramos; la app ofrece agregarla.
    if (!pmId) return ok({ paid: false, reason: 'sin_tarjeta' });

    // Precio server-side (nunca del cliente): leemos los productos del gym.
    const { data: prods } = await admin
      .from('productos')
      .select('id, tenant_id, activo, precio_centavos, moneda, nombre')
      .in('id', items.map((it) => it.producto_id));
    const porId = new Map<string, any>();
    for (const p of (prods as any[]) ?? []) porId.set(p.id, p);

    let total = 0;
    let currency = 'mxn';
    for (const it of items) {
      const p = porId.get(it.producto_id);
      if (!p || p.tenant_id !== socio.tenant_id || p.activo !== true) {
        return badRequest('Uno de los productos ya no está disponible');
      }
      total += (p.precio_centavos as number) * it.cantidad;
      currency = (p.moneda || 'MXN').toLowerCase();
    }
    if (total <= 0) return badRequest('Total inválido');

    const feePct = Number(optionalEnv('SALA_SOCIO_FEE_PERCENT', '0')) || 0;

    // El carrito viaja en el metadata del PaymentIntent para que, si esta función
    // muriera justo DESPUÉS de cobrar y ANTES de registrar, el webhook de Connect
    // pueda re-armar la venta (registrar_venta_online es idempotente por el PI).
    // Cabe con holgura en carritos normales; si no cupiera, la red de seguridad
    // no aplica pero el registro síncrono de abajo sigue siendo el camino real.
    const itemsStr = JSON.stringify(itemsJson);
    const metaVenta: Record<string, string> = {
      app: 'sala',
      tipo: 'tienda',
      usuario_id: socio.id,
      tenant_id: socio.tenant_id,
      entrega_tipo: entregaTipo,
      ...(sucursalId ? { sucursal_id: sucursalId } : {}),
      ...(entregaUbicacion ? { entrega_ubicacion: entregaUbicacion } : {}),
      ...(itemsStr.length <= 480 ? { items: itemsStr } : {})
    };

    // Cobro inmediato contra la tarjeta guardada (sin el socio "presente" en
    // Stripe). Si el banco pide 3DS off_session, Stripe lanza y lo tratamos como
    // 'requiere_autenticacion'.
    let intent;
    try {
      intent = await stripe.paymentIntents.create(
        {
          amount: total,
          currency,
          customer: customerId,
          payment_method: pmId,
          off_session: true,
          confirm: true,
          description: 'Tienda',
          metadata: metaVenta,
          ...(feePct > 0 ? { application_fee_amount: Math.round((total * feePct) / 100) } : {})
        },
        { stripeAccount: acct }
      );
    } catch (e: any) {
      const code = e?.code || e?.raw?.code;
      if (code === 'authentication_required') {
        return ok({ paid: false, reason: 'requiere_autenticacion' });
      }
      // Tarjeta rechazada / fondos / etc. → mensaje del banco, sin registrar nada.
      return ok({ paid: false, reason: 'rechazada', mensaje: e?.message ?? 'La tarjeta fue rechazada' });
    }

    if (intent.status !== 'succeeded') {
      return ok({ paid: false, reason: 'no_completado', estado: intent.status });
    }

    // Cobro OK → registrar la venta (Caja + stock + cola de entrega), idempotente
    // por el id del PaymentIntent. Si acá falla (p. ej. se agotó en la carrera),
    // reembolsamos: no dejamos dinero cobrado sin venta.
    const { data: result, error: rpcErr } = await admin.rpc('registrar_venta_online', {
      p_tenant_id: socio.tenant_id,
      p_usuario_id: socio.id,
      p_sucursal_id: sucursalId,
      p_items: itemsJson,
      p_referencia: intent.id,
      p_entrega_tipo: entregaTipo,
      p_entrega_ubicacion: entregaUbicacion
    });
    if (rpcErr) {
      // OJO: `rpcErr` puede ser un RAISE de negocio (SIN_STOCK → la venta NO se
      // asentó, hay que reembolsar) o un timeout de red DESPUÉS de que la RPC
      // commiteó (la venta SÍ existe). Antes de reembolsar, confirmamos que NO
      // haya un pago con esta referencia; si existe, la venta se registró y
      // reembolsar regalaría el producto. En ese caso la damos por buena.
      const { data: pagoExistente } = await admin
        .from('pagos')
        .select('id')
        .eq('tenant_id', socio.tenant_id)
        .eq('referencia', intent.id)
        .maybeSingle();
      if (pagoExistente) {
        console.warn('[comprar-producto] rpcErr pero la venta SÍ se registró pi=', intent.id, rpcErr.message);
        return ok({ paid: true, referencia: intent.id });
      }
      try {
        await stripe.refunds.create({ payment_intent: intent.id }, { stripeAccount: acct });
      } catch (re) {
        // Reembolso falló: hay que resolverlo a mano. Lo dejamos MUY visible.
        console.error('[comprar-producto] REEMBOLSO FALLIDO pi=', intent.id, re);
        return serverError('Cobramos pero no pudimos completar la venta. Te contactamos para resolverlo.');
      }
      return ok({ paid: false, reason: motivoRpc(rpcErr.message) });
    }

    return ok({ paid: true, ...(result as object) });
  } catch (err) {
    console.error('[comprar-producto]', err instanceof Error ? err.message : err);
    return serverError('No pudimos completar la compra');
  }
};

/** Traduce la excepción de registrar_venta_online a un motivo estable para la app. */
function motivoRpc(msg: string): string {
  if (msg.includes('SIN_STOCK')) return 'sin_stock';
  if (msg.includes('PRODUCTO_INVALIDO')) return 'producto_invalido';
  if (msg.includes('SIN_ITEMS')) return 'carrito_vacio';
  if (msg.includes('ENTREGA_INVALIDA')) return 'entrega_invalida';
  return 'error';
}