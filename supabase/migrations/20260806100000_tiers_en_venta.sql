-- ============================================================================
-- Separar "EN VENTA" del ACCESO de los socios que ya tienen el plan
-- ============================================================================
-- Problema: para "dejar de vender" un plan, el admin lo desactivaba (activo=false).
-- Pero eso disparaba un trigger que le quitaba el plan a la lista de las salas
-- (tiers_permitidos) → los socios que YA tenían ese plan dejaban de poder reservar.
-- Desactivar (una decisión de venta) rompía a clientes actuales.
--
-- Fix, en dos partes:
--   1) Bandera `en_venta`: controla landing + venta a nuevos, SIN tocar el acceso.
--   2) El trigger deja de limpiar el acceso al ARCHIVAR; solo un DELETE real lo hace.
-- ============================================================================

-- ── 1) Bandera de venta (independiente del acceso) ───────────────────────────
ALTER TABLE tiers ADD COLUMN IF NOT EXISTS en_venta boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN tiers.en_venta IS
  'true = visible en landing y vendible a socios nuevos. false = oculto de la venta, pero NO afecta el acceso de quienes ya lo tienen (a diferencia de activo=false). Para "ya no se vende", apagar esto, NO archivar.';

-- ── 2) Archivar ya NO quita el acceso — solo el borrado real ──────────────────
-- Antes: AFTER UPDATE OF activo OR DELETE, y en activo→inactivo removía el slug de
-- tiers_permitidos (rompía a los socios actuales). Ahora: solo en DELETE.
CREATE OR REPLACE FUNCTION trg_tier_fuera_de_recursos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Un UPDATE (archivar/desarchivar) ya no toca el acceso de nadie.
  IF TG_OP <> 'DELETE' THEN
    RETURN NEW;
  END IF;

  -- Borrado real: limpiar el slug fantasma de las listas de las salas.
  UPDATE recursos
  SET tiers_permitidos = array_remove(tiers_permitidos, OLD.slug)
  WHERE tenant_id = OLD.tenant_id
    AND OLD.slug = ANY(tiers_permitidos);

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tier_archivado_libera_recursos ON tiers;
CREATE TRIGGER tier_archivado_libera_recursos
  AFTER DELETE ON tiers
  FOR EACH ROW
  EXECUTE FUNCTION trg_tier_fuera_de_recursos();

-- ── Verificación (devuelve tabla) ────────────────────────────────────────────
SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tiers' AND column_name = 'en_venta'
  )                                                                    AS columna_en_venta,
  (
    SELECT string_agg(DISTINCT event_manipulation, ',')
    FROM information_schema.triggers
    WHERE trigger_name = 'tier_archivado_libera_recursos'
  )                                                                    AS trigger_solo_delete;
