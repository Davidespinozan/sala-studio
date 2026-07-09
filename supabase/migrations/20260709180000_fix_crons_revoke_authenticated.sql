-- ============================================================================
-- FIX: generar_recordatorios_reservas() y expirar_membresias_vencidas() seguían
-- ejecutables por `authenticated`. Causa: Supabase concede EXECUTE en funciones
-- nuevas a authenticated/anon por DEFAULT PRIVILEGES — un `REVOKE FROM PUBLIC`
-- no toca ese grant directo. Hay que revocar de authenticated y anon también.
--
-- Severidad baja (ambas son SECURITY DEFINER pero idempotentes y sin daño real
-- si se llaman sueltas), pero deben quedar solo para el cron (service_role).
-- ============================================================================

REVOKE EXECUTE ON FUNCTION generar_recordatorios_reservas() FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION generar_recordatorios_reservas() TO service_role;

REVOKE EXECUTE ON FUNCTION expirar_membresias_vencidas() FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION expirar_membresias_vencidas() TO service_role;

-- ── Verificación (devuelve tabla) — se esperan las 4 en true ──
SELECT 'recordatorios NO ejecutable por authenticated' AS check,
       NOT has_function_privilege('authenticated', 'generar_recordatorios_reservas()', 'EXECUTE') AS ok
UNION ALL
SELECT 'recordatorios ejecutable por service_role',
       has_function_privilege('service_role', 'generar_recordatorios_reservas()', 'EXECUTE')
UNION ALL
SELECT 'expirar_membresias NO ejecutable por authenticated',
       NOT has_function_privilege('authenticated', 'expirar_membresias_vencidas()', 'EXECUTE')
UNION ALL
SELECT 'expirar_membresias ejecutable por service_role',
       has_function_privilege('service_role', 'expirar_membresias_vencidas()', 'EXECUTE');
