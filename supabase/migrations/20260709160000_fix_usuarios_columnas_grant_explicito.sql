-- ============================================================================
-- FIX de 20260709150000: el REVOKE de columna NO tuvo efecto porque
-- authenticated/anon tienen un GRANT SELECT a nivel de TABLA (todas las
-- columnas). En Postgres no se puede "restar" una columna de un grant de tabla;
-- hay que revocar el SELECT de tabla completa y re-otorgar SOLO las columnas
-- permitidas (todas menos stripe_customer_id y ob_data).
-- ============================================================================

-- authenticated
REVOKE SELECT ON usuarios FROM authenticated;
GRANT SELECT (
  id, auth_id, tenant_id, email, nombre, telefono, avatar_url, rol, status,
  membresia_tier, membresia_activa_id, trial_ends_at, commitment_ends_at,
  no_shows_count, bloqueado_hasta, notas_admin, sucursal_id, invitado,
  created_at, updated_at
) ON usuarios TO authenticated;

-- anon (mismo criterio; RLS filtra las filas igual)
REVOKE SELECT ON usuarios FROM anon;
GRANT SELECT (
  id, auth_id, tenant_id, email, nombre, telefono, avatar_url, rol, status,
  membresia_tier, membresia_activa_id, trial_ends_at, commitment_ends_at,
  no_shows_count, bloqueado_hasta, notas_admin, sucursal_id, invitado,
  created_at, updated_at
) ON usuarios TO anon;

-- Cerrar también un posible grant de tabla vía PUBLIC (service_role conserva su
-- propio GRANT ALL, no depende de PUBLIC).
REVOKE SELECT ON usuarios FROM PUBLIC;

-- ── Verificación (devuelve tabla) — se esperan las 4 en true ──
SELECT 'authenticated NO lee stripe_customer_id' AS check,
       NOT has_column_privilege('authenticated', 'usuarios', 'stripe_customer_id', 'SELECT') AS ok
UNION ALL
SELECT 'authenticated SÍ lee nombre (no sensible)',
       has_column_privilege('authenticated', 'usuarios', 'nombre', 'SELECT')
UNION ALL
SELECT 'anon NO lee ob_data',
       NOT has_column_privilege('anon', 'usuarios', 'ob_data', 'SELECT')
UNION ALL
SELECT 'service_role SÍ lee stripe_customer_id',
       has_column_privilege('service_role', 'usuarios', 'stripe_customer_id', 'SELECT');
