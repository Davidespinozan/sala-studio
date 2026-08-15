-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- SEPARAR "vendible" de "visible en la landing".
-- ────────────────────────────────────────────────────────────────────────────
-- Hasta hoy, `en_venta` hacía DOS cosas a la vez: se puede vender + se muestra en
-- la landing pública. No había forma de tener un plan vendible en recepción pero
-- OCULTO del público — justo lo que numa necesita para el Day Pass (se cobra en
-- mostrador, pero no se anuncia en la landing).
--
-- Se agrega `visible_landing` (independiente):
--   • en_venta       = se puede VENDER a socios nuevos (recepción y alta).
--   • visible_landing = aparece en la LANDING pública y el signup.
--   • activo         = ACCESO de quienes ya lo tienen (sin cambios).
--
-- La landing muestra: en_venta = true AND visible_landing = true.
-- Default true → los planes actuales siguen igual (nadie desaparece de la landing).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE tiers ADD COLUMN IF NOT EXISTS visible_landing boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN tiers.visible_landing IS
  'true = aparece en la landing pública y el signup. false = se vende SOLO en recepción/alta (no se anuncia al público; ej. un Day Pass). Independiente de en_venta (vendible) y de activo (acceso).';

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA: la columna existe y su default es true (nada cambia
-- para los planes actuales).
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'tiers.visible_landing' AS prueba,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tiers' AND column_name = 'visible_landing'
  ) AS columna_ok,
  (
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'tiers' AND column_name = 'visible_landing'
  ) AS default_esperado_true,
  (SELECT count(*) FROM tiers WHERE visible_landing = false) AS planes_ocultos_hoy;
