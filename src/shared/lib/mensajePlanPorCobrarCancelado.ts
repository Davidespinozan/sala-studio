/**
 * Texto del toast cuando recepción/admin cancela un plan "por cobrar"
 * (cancelar_cargo_pendiente → _cancelar_plan_por_cobrar). El RPC dice cuántas
 * reservas futuras liberó y si hay una clase ya iniciada que se quedó: esa se
 * cobra al plan que el socio tenga vigente al marcar su asistencia.
 */
export interface PlanPorCobrarCanceladoResult {
  plan_cancelado?: boolean;
  reason?: string;
  reservas_liberadas?: number;
  reservas_en_curso?: number;
}

export function mensajePlanPorCobrarCancelado(
  plan: PlanPorCobrarCanceladoResult,
  prefijo: string
): string {
  const liberadas = plan.reservas_liberadas ?? 0;
  const enCurso = plan.reservas_en_curso ?? 0;
  const partes = [prefijo];
  if (liberadas === 1) partes.push('Se liberó 1 reserva futura.');
  else if (liberadas > 1) partes.push(`Se liberaron ${liberadas} reservas futuras.`);
  else partes.push('No tenía reservas futuras.');
  if (enCurso > 0) {
    partes.push(
      enCurso === 1
        ? 'Tiene una clase en curso: al marcar su asistencia se contará en el plan que tenga vigente.'
        : `Tiene ${enCurso} clases en curso: al marcar su asistencia se contarán en el plan que tenga vigente.`
    );
  }
  return partes.join(' ');
}
