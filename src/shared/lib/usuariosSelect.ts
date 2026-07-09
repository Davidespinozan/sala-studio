/**
 * Columnas de `usuarios` que el cliente (rol authenticated/anon) puede leer.
 *
 * EXCLUYE a propósito `stripe_customer_id` y `ob_data`: son sensibles (id de
 * cliente de Stripe / datos de onboarding con PII). Su SELECT está REVOCADO a
 * nivel de columna para authenticated y anon (migración
 * 20260709150000_usuarios_columnas_privadas.sql) — solo el backend
 * (service_role) las lee. Por eso NO se puede hacer select('*') sobre usuarios
 * desde el cliente (fallaría con "permission denied for column"); usar esta
 * lista en su lugar.
 *
 * Si agregás una columna NO sensible a `usuarios` y el cliente la necesita,
 * añadila acá.
 */
export const COLUMNAS_USUARIO_CLIENTE =
  'id, auth_id, tenant_id, email, nombre, telefono, avatar_url, rol, status, ' +
  'membresia_tier, membresia_activa_id, trial_ends_at, commitment_ends_at, ' +
  'no_shows_count, bloqueado_hasta, notas_admin, sucursal_id, invitado, ' +
  'created_at, updated_at';
