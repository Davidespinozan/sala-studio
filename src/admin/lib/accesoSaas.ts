import type { SuscripcionSaas } from '../hooks/useSuscripcion';

export type NivelAcceso = 'ok' | 'aviso' | 'bloqueo';
export type MotivoSaas = 'trial_por_vencer' | 'trial_vencido' | 'cancelada' | 'vencida' | 'sin_tarjeta';
/** Solo estos motivos pueden llegar a BLOQUEO (el paywall). */
export type MotivoBloqueo = 'trial_vencido' | 'cancelada' | 'vencida' | 'sin_tarjeta';

export interface EstadoAccesoSaas {
  nivel: NivelAcceso;
  motivo: MotivoSaas | null;
  /** Días (redondeados hacia arriba) que faltan para el CORTE. null si nivel='ok'. */
  diasParaCorte: number | null;
}

/** Cuántos días ANTES de que venza el trial se empieza a avisar. */
export const PREAVISO_DIAS = 3;
// GRACIA POR CASO. Antes era un único 5 para las tres situaciones, y eso
// regalaba días a quien no correspondía: al que canceló se le sumaban 5 días
// sobre lo que ya había pagado (el cartel llegaba a decir "12 días más"), y al
// que nunca puso tarjeta, 5 días de barra libre. Los únicos días gratis del
// producto son los de la prueba.

/** Prueba vencida sin tarjeta. Mínimo: el que no pagó en 7 días no paga en 12. */
export const GRACIA_TRIAL_DIAS = 1;
/** Canceló: pidió irse. Llega hasta donde pagó, ni un día más. */
export const GRACIA_CANCELADA_DIAS = 0;
/** Le falló el pago: ES cliente y suele ser una tarjeta vencida. Merece aire. */
export const GRACIA_VENCIDA_DIAS = 5;
const DIA_MS = 86_400_000;
/** Margen tras el alta para que el webhook de Stripe escriba la suscripción. */
const GRACIA_ALTA_MS = 15 * 60_000;

const OK: EstadoAccesoSaas = { nivel: 'ok', motivo: null, diasParaCorte: null };

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}
const diasHasta = (t: number, ahora: number) => Math.max(0, Math.ceil((t - ahora) / DIA_MS));

/**
 * Estado de acceso del gym al SaaS: ok / aviso / bloqueo.
 *
 * No se corta de golpe: cuando el trial vence o el pago falla, primero hay una
 * ventana de GRACIA (nivel 'aviso', sigue operando) y RECIÉN después cae el
 * paywall ('bloqueo'). Cortarle el negocio a un gym sin avisar —quizás a uno
 * que sí va a pagar— es la peor experiencia posible.
 *
 * FALLA ABIERTO: ante cualquier duda devuelve 'ok'. Sin suscripción, 'activa',
 * 'pausada', trial vigente lejos del vencimiento → ok. Solo escala con señal
 * clara y fecha. El DEMO se exime antes de llamar a esto.
 *
 * La gracia de Stripe (past_due) NO llega acá: el webhook la mapea a 'activa'.
 */
export function estadoAccesoSaas(
  suscripcion: SuscripcionSaas | null,
  ahora: number = Date.now()
): EstadoAccesoSaas {
  if (!suscripcion) return OK;

  switch (suscripcion.estado) {
    case 'activa':
    case 'pausada':
      // 'activa' auto-renueva y Stripe maneja su propio dunning/emails.
      return OK;

    case 'trial': {
      // SIN TARJETA NO HAY PRUEBA. Un trial sin medio de pago es un lead que se
      // pierde en silencio: llega al día 7, se corta, y nunca nadie registró una
      // tarjeta. Se bloquea de entrada y se le pide elegir plan + tarjeta; la
      // prueba corre igual, pero recién desde que hay con qué cobrarle.
      //
      // Los 'mock_' (placeholders del checkout viejo) cuentan como SIN tarjeta:
      // nunca hubo un medio de pago de verdad. El tenant DEMO no se ve afectado
      // porque AdminLayout lo exime antes de llamar acá.
      //
      // GRACIA CORTA tras el alta: el `stripe_subscription_id` lo escribe el
      // WEBHOOK, unos segundos después de pagar. Sin esta ventana, un gym que
      // acaba de poner la tarjeta y entra al panel enseguida vería "activá tu
      // plan" habiendo pagado — falso y alarmante. Preferimos dejar pasar unos
      // minutos a un alta sin pagar que asustar a uno que sí pagó.
      const subId = suscripcion.stripe_subscription_id;
      if (subId == null || subId.startsWith('mock_')) {
        const creada = ms(suscripcion.created_at);
        const reciente = creada != null && ahora - creada < GRACIA_ALTA_MS;
        if (!reciente) {
          return { nivel: 'bloqueo', motivo: 'sin_tarjeta', diasParaCorte: 0 };
        }
      }

      const fin = ms(suscripcion.trial_termina);
      if (fin == null) return OK; // sin fecha → no sabemos → no molestamos
      const corte = fin + GRACIA_TRIAL_DIAS * DIA_MS;

      if (ahora <= fin) {
        // Trial vigente: avisar solo si está por vencer (para que ponga tarjeta).
        if (fin - ahora <= PREAVISO_DIAS * DIA_MS) {
          return { nivel: 'aviso', motivo: 'trial_por_vencer', diasParaCorte: diasHasta(corte, ahora) };
        }
        return OK;
      }
      // Trial vencido: gracia y después corte.
      if (ahora <= corte) return { nivel: 'aviso', motivo: 'trial_vencido', diasParaCorte: diasHasta(corte, ahora) };
      return { nivel: 'bloqueo', motivo: 'trial_vencido', diasParaCorte: 0 };
    }

    case 'cancelada': {
      const fin = ms(suscripcion.periodo_actual_termina);
      // Sin fecha de período: ya no hay acceso pagado → corte.
      if (fin == null) return { nivel: 'bloqueo', motivo: 'cancelada', diasParaCorte: 0 };
      const corte = fin + GRACIA_CANCELADA_DIAS * DIA_MS;
      // Canceló pero pagó hasta 'fin' (o dentro de la gracia): sigue, avisado.
      if (ahora <= corte) return { nivel: 'aviso', motivo: 'cancelada', diasParaCorte: diasHasta(corte, ahora) };
      return { nivel: 'bloqueo', motivo: 'cancelada', diasParaCorte: 0 };
    }

    case 'vencida': {
      // Stripe ya agotó sus reintentos. Referencia: hasta cuándo estaba pago
      // (o, si no hay, cuándo pasó a vencida).
      const fin = ms(suscripcion.periodo_actual_termina) ?? ms(suscripcion.updated_at);
      if (fin == null) return { nivel: 'bloqueo', motivo: 'vencida', diasParaCorte: 0 };
      const corte = fin + GRACIA_VENCIDA_DIAS * DIA_MS;
      if (ahora <= corte) return { nivel: 'aviso', motivo: 'vencida', diasParaCorte: diasHasta(corte, ahora) };
      return { nivel: 'bloqueo', motivo: 'vencida', diasParaCorte: 0 };
    }

    default:
      return OK;
  }
}