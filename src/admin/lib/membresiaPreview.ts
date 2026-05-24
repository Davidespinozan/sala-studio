/**
 * Preview puro del efecto que va a tener gestionar_membresia_socio cuando el
 * admin elija un tier. Replica EXACTAMENTE la lógica del RPC (Fase 4) para
 * mostrarle al admin "qué va a pasar" antes de confirmar:
 *   - alta nueva
 *   - renovación mismo tipo (suma fechas si vigente, desde hoy si vencida)
 *   - cambio de tipo (resetea, posiblemente pierde créditos)
 *
 * Función pura: recibe `now` como parámetro para tests deterministas.
 *
 * IMPORTANTE — si la lógica del RPC cambia, este helper también. Los tests
 * unitarios chequean los casos pero la fuente de verdad final es el RPC.
 * El preview es SOLO UI; el RPC es quien efectivamente aplica el cambio.
 */

export type TipoTier = 'tiempo' | 'creditos' | 'hibrido';

export type ModoMembresia =
  | 'alta'
  | 'renovacion'
  | 'renovacion_desde_hoy'
  | 'cambio_de_tipo';

export interface MembresiaActualResumen {
  tier_tipo: TipoTier;
  periodo_actual_fin: string | null; // ISO
  creditos_restantes: number | null;
}

export interface TierResumen {
  tipo: TipoTier;
  duracion_dias: number | null;
  clases_incluidas: number | null;
}

export interface MembresiaPreview {
  modo: ModoMembresia;
  nuevoFin: Date | null;
  nuevoSaldo: number | null;
  delta: number;             // saldo nuevo - saldo anterior (signed)
  creditosPerdidos: number;  // > 0 solo en cambio_de_tipo con saldo previo
}

export function previewGestionarMembresia(
  actual: MembresiaActualResumen | null,
  nuevoTier: TierResumen,
  now: Date = new Date()
): MembresiaPreview {
  const saldoAnterior = actual?.creditos_restantes ?? null;
  const finAnterior = actual?.periodo_actual_fin
    ? new Date(actual.periodo_actual_fin)
    : null;

  const finDesdeHoy = (): Date | null =>
    nuevoTier.duracion_dias == null
      ? null
      : new Date(now.getTime() + nuevoTier.duracion_dias * 86_400_000);

  const finSumado = (): Date | null => {
    if (nuevoTier.duracion_dias == null) return null;
    if (finAnterior && finAnterior > now) {
      return new Date(finAnterior.getTime() + nuevoTier.duracion_dias * 86_400_000);
    }
    return finDesdeHoy();
  };

  const saldoConReset = (): number | null =>
    nuevoTier.tipo === 'tiempo' ? null : nuevoTier.clases_incluidas;

  const saldoSumado = (): number | null =>
    nuevoTier.tipo === 'tiempo'
      ? null
      : (saldoAnterior ?? 0) + (nuevoTier.clases_incluidas ?? 0);

  let modo: ModoMembresia;
  let nuevoFin: Date | null;
  let nuevoSaldo: number | null;

  if (!actual) {
    modo = 'alta';
    nuevoFin = finDesdeHoy();
    nuevoSaldo = saldoConReset();
  } else if (actual.tier_tipo === nuevoTier.tipo) {
    // Mismo tipo: renovación / recarga
    if (nuevoTier.duracion_dias == null) {
      modo = 'renovacion';
      nuevoFin = null;
    } else if (finAnterior && finAnterior > now) {
      modo = 'renovacion';
      nuevoFin = finSumado();
    } else {
      modo = 'renovacion_desde_hoy';
      nuevoFin = finDesdeHoy();
    }
    nuevoSaldo = saldoSumado();
  } else {
    // Cambio de tipo → reset
    modo = 'cambio_de_tipo';
    nuevoFin = finDesdeHoy();
    nuevoSaldo = saldoConReset();
  }

  const delta = (nuevoSaldo ?? 0) - (saldoAnterior ?? 0);
  const creditosPerdidos =
    modo === 'cambio_de_tipo' && (saldoAnterior ?? 0) > 0
      ? (saldoAnterior as number)
      : 0;

  return { modo, nuevoFin, nuevoSaldo, delta, creditosPerdidos };
}

/**
 * Texto humano para el preview. Para mostrar al admin antes de confirmar.
 * El modal compone el render visual final; este helper solo arma la frase
 * principal y notas auxiliares.
 */
export function describirPreview(
  preview: MembresiaPreview,
  nuevoTier: TierResumen
): { titulo: string; detalle: string; advertencia: string | null } {
  const fecha = preview.nuevoFin
    ? preview.nuevoFin.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  const clasesTexto = (n: number | null): string =>
    n == null ? '' : n === 1 ? '1 clase' : `${n} clases`;

  switch (preview.modo) {
    case 'alta':
      return {
        titulo: 'Alta de membresía',
        detalle:
          nuevoTier.tipo === 'tiempo'
            ? `Inicia hoy y vence el ${fecha}.`
            : fecha
              ? `Inicia con ${clasesTexto(preview.nuevoSaldo)} disponibles hasta el ${fecha}.`
              : `Inicia con ${clasesTexto(preview.nuevoSaldo)} disponibles.`,
        advertencia: null
      };

    case 'renovacion':
      return {
        titulo: 'Renovación',
        detalle:
          nuevoTier.tipo === 'tiempo'
            ? `Suma ${nuevoTier.duracion_dias} días al vencimiento actual. Nuevo vencimiento: ${fecha}.`
            : fecha
              ? `Saldo nuevo: ${clasesTexto(preview.nuevoSaldo)}. Vence el ${fecha}.`
              : `Suma ${clasesTexto(nuevoTier.clases_incluidas)} al saldo. Saldo nuevo: ${clasesTexto(preview.nuevoSaldo)}.`,
        advertencia: null
      };

    case 'renovacion_desde_hoy':
      return {
        titulo: 'Renovación (desde hoy)',
        detalle:
          nuevoTier.tipo === 'tiempo'
            ? `La membresía estaba vencida. Reinicia hoy y vence el ${fecha}.`
            : fecha
              ? `La membresía estaba vencida. Saldo nuevo: ${clasesTexto(preview.nuevoSaldo)}. Vence el ${fecha}.`
              : `La membresía estaba vencida. Saldo nuevo: ${clasesTexto(preview.nuevoSaldo)}.`,
        advertencia: null
      };

    case 'cambio_de_tipo':
      return {
        titulo: 'Cambio de plan',
        detalle:
          nuevoTier.tipo === 'tiempo'
            ? `Cambia a plan por tiempo. Vence el ${fecha}.`
            : fecha
              ? `Cambia a plan con clases. Arranca con ${clasesTexto(preview.nuevoSaldo)} hasta el ${fecha}.`
              : `Cambia a plan con clases. Arranca con ${clasesTexto(preview.nuevoSaldo)}.`,
        advertencia:
          preview.creditosPerdidos > 0
            ? `Atención: el socio pierde ${clasesTexto(preview.creditosPerdidos)} del plan anterior al cambiar de tipo.`
            : null
      };
  }
}
