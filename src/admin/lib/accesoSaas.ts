import type { SuscripcionSaas } from '../hooks/useSuscripcion';

export type MotivoBloqueo = 'trial_vencido' | 'cancelada' | 'vencida';

/**
 * ¿El panel del gym está bloqueado por falta de pago del SaaS?
 *
 * FALLA ABIERTO a propósito: solo devuelve un motivo cuando hay una señal CLARA
 * de suscripción muerta. Dejar afuera a un gym que SÍ paga es peor que dejar
 * pasar a un colado, así que ante cualquier duda → null (no bloquea):
 *   - sin fila de suscripción           → null (no sabemos → no bloqueamos)
 *   - 'activa'                          → null
 *   - 'trial' con trial_termina futuro  → null (trial vigente)
 *   - 'pausada'                         → null (ambiguo; se revisa aparte)
 *   - 'cancelada' pero con período aún vigente (cancela al fin de período) → null
 *
 * El DEMO se exime antes de llamar a esto (nunca se bloquea).
 * La gracia de Stripe (past_due) NO llega acá: el webhook la mapea a 'activa'.
 */
export function motivoBloqueoSaas(
  suscripcion: SuscripcionSaas | null,
  ahora: number = Date.now()
): MotivoBloqueo | null {
  if (!suscripcion) return null;

  switch (suscripcion.estado) {
    case 'vencida':
      // Stripe intentó cobrar, falló y agotó los reintentos.
      return 'vencida';

    case 'cancelada': {
      // Cancelada suele ser "cancela al fin del período": mantiene acceso hasta
      // que ese período termina. Solo bloqueamos cuando ya venció (o no hay fecha).
      const fin = suscripcion.periodo_actual_termina;
      if (!fin || new Date(fin).getTime() <= ahora) return 'cancelada';
      return null;
    }

    case 'trial': {
      const fin = suscripcion.trial_termina;
      if (fin && new Date(fin).getTime() <= ahora) return 'trial_vencido';
      return null;
    }

    // 'activa' | 'pausada' | cualquier otro → no bloquear.
    default:
      return null;
  }
}