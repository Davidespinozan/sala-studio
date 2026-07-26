/**
 * ¿Este gym cobra online?
 *
 * `tenants.stripe_charges_enabled` lo pone el webhook de Stripe Connect cuando la
 * cuenta del gym termina el onboarding y ya puede cobrar. Un gym que cobra en
 * efectivo en el mostrador NUNCA lo tiene en true.
 *
 * Importa porque la app del socio prometía cosas que en ese caso no existen:
 * "cambiá de plan cuando quieras desde acá" y "agregá tu tarjeta en Método de
 * pago". Para un socio de un gym que cobra en efectivo, esos botones no llevan a
 * ningún lado — y el FAQ que se lo prometía estaba escrito a mano en el código.
 *
 * La columna no está en los tipos generados de Supabase (quedaron viejos), así
 * que el cast vive acá, en un solo lugar, y no repartido por la app.
 */
export function gymCobraOnline(tenant: unknown): boolean {
  return (tenant as { stripe_charges_enabled?: boolean } | null)?.stripe_charges_enabled === true;
}

import { autoservicioActivo } from './cobrosConfig';

/**
 * ¿El SOCIO puede pagar por su cuenta desde la app/landing?
 *
 * Dos condiciones: (1) el gym cobra online (Connect listo) y (2) el gym tiene el
 * autoservicio prendido. numa cobra 100% en recepción → lo apaga, y aunque algún
 * día active Connect (p. ej. por la Tienda), las membresías siguen sin venderse
 * solas. Es el interruptor de "la app es para reservar, el pago es en el
 * mostrador". Las superficies de cobro de membresía se gatean con esto.
 */
export function socioPuedePagarEnApp(tenant: unknown): boolean {
  const config = (tenant as { config?: Record<string, unknown> } | null)?.config ?? null;
  return gymCobraOnline(tenant) && autoservicioActivo(config);
}
