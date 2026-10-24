import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe, Stripe } from '../_lib/stripe';

/**
 * POST /cancelacion-stripe — BLOCK 2C: programa o retira una cancelación
 * Stripe (detiene/reanuda la renovación, conserva el acceso pagado hasta el
 * fin del periodo). Un solo endpoint para socio (sobre sí mismo) y recepción/
 * admin (sobre otro socio, con motivo obligatorio) — la autorización real
 * vive en iniciar_operacion_cancelacion (BLOCK 2A), este archivo solo
 * orquesta: RPC de inicio → Stripe → RPC de confirmación.
 *
 * Auth: Bearer JWT del actor real (socio o staff). Body:
 *   { usuario_id, accion: 'programar'|'retirar', motivo?, operacion_id? }
 * `operacion_id` es opcional: si el cliente reintenta tras no saber si una
 * llamada anterior aplicó, lo reenvía para que la confirmación sea
 * idempotente por identidad de operación (BLOCK 2A ya lo garantiza).
 *
 * Nunca llama a Stripe si iniciar_operacion_cancelacion no se confirmó antes
 * (si esa RPC falla, se corta ahí — Stripe ni se toca). Un resultado
 * ambiguo de Stripe (error de conexión, no un rechazo explícito) NO se
 * reporta como éxito ni como fallo: la operación queda 'en_ejecucion' y la
 * respuesta es 'procesando' — BLOCK 2B (reconciliador) la resuelve sola más
 * adelante, sin un tiempo máximo garantizado (depende de que Stripe haya
 * procesado la solicitud original, algo que no podemos verificar nosotros
 * mismos con certeza absoluta — ver el diseño de 2B).
 *
 * SEGURIDAD (BLOCK2H): `confirmar_operacion_cancelacion` es exclusiva de
 * service_role (no `authenticated`) — escribe el resultado ECONÓMICO
 * asumiendo que YA se habló con Stripe, y confiar eso a cualquier cliente
 * dejaría fabricar una cancelación/fecha sin que Stripe la haya visto nunca
 * (confirmado en sandbox). Por eso las 3 llamadas de este archivo usan
 * `admin.rpc` (no `asUser.rpc`) y pasan `p_actor_usuario_id: callerUsuarioId`
 * — el actor YA verificado contra el JWT real más arriba, nunca un valor que
 * el cliente pudiera elegir. `iniciar_operacion_cancelacion` sigue siendo
 * `authenticated` (es solo autorización + registro, no confirma nada de
 * Stripe).
 */

interface Body {
  usuario_id?: string;
  accion?: 'programar' | 'retirar';
  motivo?: string;
  operacion_id?: string;
}

function epochToISO(epoch: unknown): string | null {
  return typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
}
function periodEndISO(sub: any): string | null {
  const item = sub?.items?.data?.[0];
  return epochToISO(sub?.current_period_end ?? item?.current_period_end ?? null);
}

/** Error de Stripe donde NO sabemos con certeza si la solicitud llegó a
 * aplicarse (problema de red/conexión, o un 5xx del lado de Stripe) —
 * distinto de un rechazo explícito (tarjeta, parámetro inválido, recurso
 * inexistente), que Stripe SÍ procesó y podemos reportar como fallo real. */
function esResultadoAmbiguo(e: unknown): boolean {
  return (
    e instanceof Stripe.errors.StripeConnectionError ||
    e instanceof Stripe.errors.StripeAPIError
  );
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('Falta usuario_id');
    if (body.accion !== 'programar' && body.accion !== 'retirar') return badRequest('accion debe ser programar o retirar');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Identidad real del caller — se resuelve ANTES de cualquier lectura por
    // operacion_id, porque ese id lo manda el cliente y por sí solo no prueba
    // nada (ver corrección de Gate 1: IDOR corregido).
    const { data: callerRow } = await admin
      .from('usuarios')
      .select('id')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!callerRow) return unauthorized('Sin perfil');
    const callerUsuarioId = callerRow.id as string;

    // Si el cliente reintenta con un operacion_id conocido, chequear su estado
    // ANTES de iniciar nada nuevo — si ya se resolvió, devolver eso directo
    // sin tocar Stripe de nuevo. CRÍTICO: solo si esa operación pertenece al
    // actor que llama (actor_usuario_id = quien la inició originalmente) —
    // conocer el UUID por sí solo NO concede acceso a su resultado. Si no
    // coincide (operación ajena o inexistente), se ignora silenciosamente y
    // sigue como una solicitud nueva — nunca revela si ese id existe o no.
    if (body.operacion_id) {
      const { data: existente } = await admin
        .from('stripe_operaciones_cancelacion')
        .select('estado, resultado')
        .eq('id', body.operacion_id)
        .eq('actor_usuario_id', callerUsuarioId)
        .maybeSingle();
      if (existente && existente.estado !== 'en_ejecucion') {
        return ok({ ok: true, operacion_id: body.operacion_id, estado: existente.estado, resultado: existente.resultado });
      }
      if (existente && existente.estado === 'en_ejecucion') {
        return ok({ ok: true, operacion_id: body.operacion_id, estado: 'procesando' });
      }
      // No existe O no es del caller: se trata igual, sin distinguir — no
      // filtra si el id existe para otro actor.
    }

    const operacionId = body.operacion_id || randomUUID();

    // 1) Iniciar — nunca se toca Stripe si esto no se confirma primero.
    const { data: inicio, error: errInicio } = await (asUser.rpc as any)(
      'iniciar_operacion_cancelacion',
      { p_operacion_id: operacionId, p_usuario_id: body.usuario_id, p_accion: body.accion, p_motivo: body.motivo ?? null }
    );
    if (errInicio) {
      // Se preserva el código (CODIGO: mensaje) sin cortarlo — el frontend
      // (translateActionError / su equivalente en member) lo traduce desde
      // ahí, igual que el resto de las acciones de recepción.
      return badRequest(errInicio.message);
    }
    if (!inicio?.ok) {
      if (inicio?.reason === 'operacion_en_curso') {
        return ok({ ok: true, estado: 'procesando', reason: 'operacion_en_curso' });
      }
      return badRequest('No se pudo iniciar la operación');
    }

    const membresiaId: string = inicio.membresia_id;
    const subId: string = inicio.stripe_subscription_id;

    // 2) Resolver tenant + cuenta Connect — SIEMPRE a partir de lo que
    // iniciar_operacion_cancelacion ya validó y bloqueó, nunca de un valor
    // aparte sin relación con esa fila (evita cualquier desalineación
    // cross-tenant/cross-account).
    const { data: mem } = await admin.from('membresias').select('tenant_id').eq('id', membresiaId).maybeSingle();
    const { data: tenant } = await admin.from('tenants').select('stripe_account_id').eq('id', mem?.tenant_id).maybeSingle();
    const acct = tenant?.stripe_account_id ?? null;

    if (!acct || !subId || subId.startsWith('mock_') || !process.env.STRIPE_SECRET_KEY) {
      // No debería pasar (iniciar_operacion_cancelacion ya exige stripe_subscription_id
      // no nulo), pero sin cuenta Connect no hay forma segura de proceder —
      // confirmar como fallo explícito, no dejar la operación colgada.
      await (admin.rpc as any)('confirmar_operacion_cancelacion', {
        p_operacion_id: operacionId, p_actor_usuario_id: callerUsuarioId,
        p_period_end_fresco: null, p_exito: false, p_error: 'sin_cuenta_stripe'
      });
      return serverError('No se pudo procesar: falta la cuenta de Stripe de este negocio');
    }

    const stripe = getStripe();

    // 3) Stripe.
    let periodEndFresco: string | null = null;
    try {
      const sub = await stripe.subscriptions.update(
        subId,
        { cancel_at_period_end: body.accion === 'programar' },
        { stripeAccount: acct }
      );
      periodEndFresco = periodEndISO(sub);
    } catch (e) {
      if (esResultadoAmbiguo(e)) {
        // No sabemos si Stripe aplicó el cambio. NO confirmamos ni como éxito
        // ni como fallo — la operación queda 'en_ejecucion' y el reconciliador
        // (BLOCK 2B) la resuelve con una lectura en vivo más adelante.
        console.error('[cancelacion-stripe] resultado ambiguo de Stripe, se deja a reconciliación', operacionId, e);
        return ok({ ok: true, operacion_id: operacionId, estado: 'procesando' });
      }
      // Rechazo explícito de Stripe (parámetro inválido, recurso inexistente,
      // etc.) — Stripe SÍ procesó la solicitud, se puede confirmar como fallo real.
      const msg = e instanceof Error ? e.message : 'Error de Stripe';
      await (admin.rpc as any)('confirmar_operacion_cancelacion', {
        p_operacion_id: operacionId, p_actor_usuario_id: callerUsuarioId,
        p_period_end_fresco: null, p_exito: false, p_error: msg
      });
      return badRequest('Stripe rechazó la operación: ' + msg);
    }

    // 4) Confirmar (idempotente por operacion_id).
    const { data: confirmado, error: errConfirmar } = await (admin.rpc as any)('confirmar_operacion_cancelacion', {
      p_operacion_id: operacionId, p_actor_usuario_id: callerUsuarioId,
      p_period_end_fresco: periodEndFresco, p_exito: true, p_error: null
    });
    if (errConfirmar) {
      // Stripe YA aplicó el cambio; la confirmación en SALA falló por algo
      // aparte (ej. conexión a Supabase cortada justo acá). Resultado
      // ambiguo del lado de SALA, mismo tratamiento: dejar que 2B lo resuelva.
      console.error('[cancelacion-stripe] Stripe aplicó pero confirmar falló, se deja a reconciliación', operacionId, errConfirmar);
      return ok({ ok: true, operacion_id: operacionId, estado: 'procesando' });
    }

    return ok({
      ok: true,
      operacion_id: operacionId,
      estado: confirmado?.membresia_terminal ? 'sin_efecto_membresia_terminal' : 'aplicado',
      resultado: confirmado
    });
  } catch (err) {
    console.error('[cancelacion-stripe]', err instanceof Error ? err.message : err);
    return serverError('No pudimos procesar la solicitud');
  }
};
