-- ============================================================================
-- Hardening de seguridad — dos hoyos abiertos desde el arranque del proyecto.
-- ----------------------------------------------------------------------------
-- 1) dev_activar_miembro(text,text): helper de DEV, SECURITY DEFINER, SIN gate
--    de rol ni tenant. Cualquier usuario logueado podía activarse (o activar a
--    cualquiera, en CUALQUIER tenant) una membresía paga gratis, por email.
--    El onboarding real ya existe → se elimina, como decía su propio comentario.
--
-- 2) marcar_no_shows(): tenía GRANT EXECUTE a `authenticated` (nunca revocado)
--    → cualquier socio podía disparar un barrido masivo de no-shows. Solo el
--    cron (service_role) debe poder ejecutarlo.
--
-- Migración idempotente. Al final devuelve una TABLA de verificación (el editor
-- esconde los NOTICE) para confirmar el estado resultante.
-- ============================================================================

-- ── 1. Eliminar el helper de DEV ──
DROP FUNCTION IF EXISTS dev_activar_miembro(text, text);

-- ── 2. Restringir marcar_no_shows() al cron (service_role) ──
REVOKE EXECUTE ON FUNCTION marcar_no_shows() FROM authenticated;
REVOKE EXECUTE ON FUNCTION marcar_no_shows() FROM anon;
GRANT  EXECUTE ON FUNCTION marcar_no_shows() TO service_role;

-- ── Verificación (devuelve tabla) ──
SELECT
  'dev_activar_miembro eliminada' AS check,
  NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'dev_activar_miembro'
  ) AS ok
UNION ALL
SELECT
  'marcar_no_shows NO ejecutable por authenticated' AS check,
  NOT has_function_privilege('authenticated', 'marcar_no_shows()', 'EXECUTE') AS ok
UNION ALL
SELECT
  'marcar_no_shows ejecutable por service_role' AS check,
  has_function_privilege('service_role', 'marcar_no_shows()', 'EXECUTE') AS ok;
