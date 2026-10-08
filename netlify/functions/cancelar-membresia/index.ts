import type { Handler } from '@netlify/functions';
import { ok } from '../_lib/http';

export const CODIGO_OBSOLETO = 'CANCELACION_ENDPOINT_OBSOLETO';

/**
 * POST /cancelar-membresia — OBSOLETO (BLOCK 2G, contención P1 de BLOCK 2F).
 *
 * Este endpoint programaba/retiraba `cancel_at_period_end` en Stripe de forma
 * independiente del mecanismo durable de BLOCK2 (`stripe_operaciones_cancelacion`
 * + `iniciar_operacion_cancelacion`/`confirmar_operacion_cancelacion`), sin su
 * índice de exclusión ni su auditoría. El frontend actual ya no lo llama (usa
 * `cancelacion-stripe`); el único consumidor que podría quedar es un bundle PWA
 * viejo en caché de algún cliente.
 *
 * Por diseño, a partir de BLOCK2G este handler NUNCA llama a Stripe ni toca
 * `membresias` — ni para programar (reactivar=false/omitido) ni para retirar
 * (reactivar=true) — sin excepción, sin importar auth/tenant/tipo de membresía.
 * Se corta ANTES de leer el body, antes de resolver el usuario y antes de
 * cualquier lectura a Supabase: no hay rama de código que llegue a
 * `stripe.subscriptions.update`. No se redirige internamente a
 * `cancelacion-stripe` — ese endpoint exige un contrato de autorización/
 * operación durable/auditoría (BLOCK2A-2C) que esta ruta vieja nunca tuvo, y
 * reenviar la solicitud sin pasar por ese contrato reintroduciría el mismo
 * riesgo que se está conteniendo.
 *
 * Contrato de respuesta: SIEMPRE 200 con
 *   { ok: false, reason: 'stripe_pendiente', codigo: 'CANCELACION_ENDPOINT_OBSOLETO', error }
 * El único consumidor es el Perfil viejo, que trata cualquier no-2xx como
 * "No pudimos cancelar. Probá de nuevo." (invita a reintentar en loop). Con
 * `ok:false` + `reason:'stripe_pendiente'` ese mismo bundle viejo muestra
 * "Para cancelar tu plan, habla con {gym}" al programar y "No pudimos
 * reactivarlo. Habla con {gym}" al reactivar — el mensaje correcto sin tocar
 * el cliente. `codigo` es el identificador estable para logs/clientes nuevos.
 *
 * No afecta los RPCs manuales (`recepcion_cancelar_membresia`,
 * `pausar-membresia`) ni BLOCK1A/1B+1C — ninguno pasa por este archivo.
 */
export const handler: Handler = async (event) => {
  // Sin body ni token en el log: solo lo necesario para medir cuántos clientes
  // viejos siguen llamando y decidir cuándo borrar la ruta.
  console.warn(`[cancelar-membresia] ${CODIGO_OBSOLETO} method=${event?.httpMethod ?? '?'}`);
  return ok({
    ok: false,
    reason: 'stripe_pendiente',
    codigo: CODIGO_OBSOLETO,
    error: `${CODIGO_OBSOLETO}: esta versión de la app ya no puede cancelar ni reactivar tu plan. Actualiza la aplicación o habla con tu gimnasio.`
  });
};
