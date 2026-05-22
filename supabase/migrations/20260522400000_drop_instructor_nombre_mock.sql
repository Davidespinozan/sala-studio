-- ============================================================================
-- Deuda técnica — drop de la columna deprecada clases.instructor_nombre_mock
-- ============================================================================
-- `instructor_nombre_mock` (text) era el placeholder del nombre de instructor
-- ANTES de que existiera la tabla `instructores` (pre-S6). La migración S6
-- (20260520130000_create_instructores.sql) creó la tabla real, movió las
-- clases a usar `instructor_id` (FK a instructores) y dejó esta columna
-- marcada como DEPRECATED, con el drop diferido a un sprint futuro. Este es
-- ese sprint.
--
-- Confirmado por grep en todo el repo: la columna está 100% muerta — ninguna
-- función/trigger/RPC SQL la lee o escribe, ningún seed la referencia, y el
-- front no la usa (los instructores salen del JOIN a `instructores`).
--
-- DROP COLUMN IF EXISTS → idempotente. La columna es text, nullable, sin
-- constraint / FK / índice → drop limpio. No toca ningún otro dato.
-- ============================================================================

ALTER TABLE clases DROP COLUMN IF EXISTS instructor_nombre_mock;

DO $$
BEGIN
  RAISE NOTICE 'clases.instructor_nombre_mock eliminada. Los instructores salen de la tabla instructores via instructor_id.';
END $$;
