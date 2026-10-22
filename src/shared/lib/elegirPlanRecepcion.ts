import { supabase } from '@shared/lib/supabase';

export interface PlanApartado {
  tier_id: string;
  tier_slug: string;
  tier_nombre: string;
  precio_centavos: number;
}

/**
 * "Pagar en recepción" desde el selector de planes de la app: deja apuntado el
 * plan elegido (usuarios.membresia_tier) para que recepción lo asigne y cobre.
 * No crea membresía ni cargo; reservar sigue bloqueado hasta que lo activen.
 */
export async function apartarPlanParaRecepcion(tierId: string): Promise<PlanApartado> {
  const { data, error } = await supabase.rpc('socio_elegir_plan_recepcion' as never, { p_tier_id: tierId } as never);
  if (error) throw new Error(traducirErrorApartarPlan(error.message));
  return data as unknown as PlanApartado;
}

export interface PlanPorCobrar {
  tier_id: string;
  tier_nombre: string;
  monto_centavos: number;
  inscripcion_centavos: number;
  cargo_id: string | null;
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
}

/**
 * "Pagar en recepción" cuando el gym lo permite (config.cobros.por_cobrar_autoservicio):
 * ACTIVA el plan de una vez y deja el cargo "por cobrar". La socia reserva ya;
 * el check-in se bloquea (PAGO_PENDIENTE) hasta que recepción cobre.
 */
export async function activarPlanPorCobrar(tierId: string): Promise<PlanPorCobrar> {
  const { data, error } = await supabase.rpc('socio_activar_plan_por_cobrar' as never, { p_tier_id: tierId } as never);
  if (error) throw new Error(traducirErrorApartarPlan(error.message));
  return data as unknown as PlanPorCobrar;
}

const MENSAJES: Record<string, string> = {
  YA_TIENE_PLAN: 'Ya tienes una membresía vigente; para cambiarla usa "Cambiar de plan".',
  CARGO_PENDIENTE_EXISTE: 'Ya tienes un pago pendiente. Págalo en recepción antes de elegir otro plan.',
  PLAN_GRATIS: 'Este plan no tiene costo: actívalo con "Suscribirme".',
  NO_DISPONIBLE: 'Este gimnasio no activa planes desde la app. Pásate a recepción para pagarlo.',
  PRUEBA_YA_USADA: 'Ya usaste tu clase de prueba. Elige un paquete o membresía.',
  PLAN_NO_DISPONIBLE: 'Ese plan ya no está a la venta. Elige otro.',
  NO_AUTH: 'Tu sesión expiró. Vuelve a iniciar sesión.',
  NO_AUTORIZADO: 'No pudimos apartar el plan con esta cuenta.'
};

export function traducirErrorApartarPlan(message: string): string {
  const code = message.match(/\b([A-Z][A-Z0-9_]{2,})\b/)?.[1];
  if (code && MENSAJES[code]) return MENSAJES[code];
  return 'No pudimos apartar el plan. Intenta de nuevo o pásate a recepción.';
}
