-- ============================================================================
-- FIX de la migración anterior (20260709120000): marcar_no_shows() seguía
-- ejecutable por `authenticated`. Motivo: en Postgres toda función nace con
-- GRANT EXECUTE a PUBLIC. Revocamos el grant directo a authenticated, pero el
-- de PUBLIC quedó → authenticated lo hereda igual. Hay que revocar de PUBLIC.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION marcar_no_shows() FROM PUBLIC;
-- (authenticated/anon ya fueron revocados en 20260709120000; PUBLIC era el que faltaba)
GRANT  EXECUTE ON FUNCTION marcar_no_shows() TO service_role;

-- ── Verificación (devuelve tabla) ──
SELECT
  'marcar_no_shows NO ejecutable por authenticated' AS check,
  NOT has_function_privilege('authenticated', 'marcar_no_shows()', 'EXECUTE') AS ok
UNION ALL
SELECT
  'marcar_no_shows NO ejecutable por anon' AS check,
  NOT has_function_privilege('anon', 'marcar_no_shows()', 'EXECUTE') AS ok
UNION ALL
SELECT
  'marcar_no_shows ejecutable por service_role' AS check,
  has_function_privilege('service_role', 'marcar_no_shows()', 'EXECUTE') AS ok;
