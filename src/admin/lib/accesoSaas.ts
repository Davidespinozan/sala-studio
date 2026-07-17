import type { SuscripcionSaas } from '../hooks/useSuscripcion';

export type NivelAcceso = 'ok' | 'aviso' | 'bloqueo';
export type MotivoSaas = 'trial_por_vencer' | 'trial_vencido' | 'cancelada' | 'vencida';
/** Solo estos motivos pueden llegar a BLOQUEO (el paywall). */
export type MotivoBloqueo = 'trial_vencido' | 'cancelada' | 'vencida';

export interface EstadoAccesoSaas {
  nivel: NivelAcceso;
  motivo: MotivoSaas | null;
  /** Días (redondeados hacia arriba) que faltan para el CORTE. null si nivel='ok'. */
  diasParaCorte: number | null;
}

/** Cuántos días ANTES de que venza el trial se empieza a avisar. */
export const PREAVISO_DIAS = 3;
/** Ventana de gracia TRAS el vencimiento antes de cortar el acceso. */
export const GRACIA_DIAS = 5;
const DIA_MS = 86_400_000;

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
      const fin = ms(suscripcion.trial_termina);
      if (fin == null) return OK; // sin fecha → no sabemos → no molestamos
      const corte = fin + GRACIA_DIAS * DIA_MS;

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
      const corte = fin + GRACIA_DIAS * DIA_MS;
      // Canceló pero pagó hasta 'fin' (o dentro de la gracia): sigue, avisado.
      if (ahora <= corte) return { nivel: 'aviso', motivo: 'cancelada', diasParaCorte: diasHasta(corte, ahora) };
      return { nivel: 'bloqueo', motivo: 'cancelada', diasParaCorte: 0 };
    }

    case 'vencida': {
      // Stripe ya agotó sus reintentos. Referencia: hasta cuándo estaba pago
      // (o, si no hay, cuándo pasó a vencida).
      const fin = ms(suscripcion.periodo_actual_termina) ?? ms(suscripcion.updated_at);
      if (fin == null) return { nivel: 'bloqueo', motivo: 'vencida', diasParaCorte: 0 };
      const corte = fin + GRACIA_DIAS * DIA_MS;
      if (ahora <= corte) return { nivel: 'aviso', motivo: 'vencida', diasParaCorte: diasHasta(corte, ahora) };
      return { nivel: 'bloqueo', motivo: 'vencida', diasParaCorte: 0 };
    }

    default:
      return OK;
  }
}