-- ============================================================================
-- Costo por producto → habilita margen/ganancia y valor de inventario
-- ============================================================================
-- La Tienda solo tenía precio (a cuánto se vende). Sin el COSTO (a cuánto se
-- compra) no se puede saber la ganancia por venta ni cuánto dinero está parado
-- en el inventario. Se agrega opcional: NULL = el dueño aún no lo capturó.
-- ============================================================================

ALTER TABLE productos ADD COLUMN IF NOT EXISTS costo_centavos integer
  CHECK (costo_centavos IS NULL OR costo_centavos >= 0);

COMMENT ON COLUMN productos.costo_centavos IS
  'Lo que le cuesta al gym cada unidad (para margen por venta y valor de inventario). NULL = no capturado todavía.';

-- ── Verificación (devuelve tabla) ────────────────────────────────────────────
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'productos' AND column_name = 'costo_centavos'
) AS columna_costo;
