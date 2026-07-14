/**
 * Los dedos que se pueden registrar. El valor viaja a la base (donde hay un CHECK
 * con esta misma lista); la etiqueta la lee una recepcionista apurada.
 *
 * El índice va primero porque es el que la gente apoya sin pensar.
 */
export const DEDOS = [
  { value: 'der_indice', label: 'Índice derecho' },
  { value: 'izq_indice', label: 'Índice izquierdo' },
  { value: 'der_pulgar', label: 'Pulgar derecho' },
  { value: 'izq_pulgar', label: 'Pulgar izquierdo' },
  { value: 'der_medio', label: 'Medio derecho' },
  { value: 'izq_medio', label: 'Medio izquierdo' },
  { value: 'der_anular', label: 'Anular derecho' },
  { value: 'izq_anular', label: 'Anular izquierdo' },
  { value: 'der_menique', label: 'Meñique derecho' },
  { value: 'izq_menique', label: 'Meñique izquierdo' },
] as const;

export type Dedo = (typeof DEDOS)[number]['value'];

export function nombreDedo(value: string): string {
  return DEDOS.find((d) => d.value === value)?.label ?? value;
}
