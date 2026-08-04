-- ── Snapshot del corte (para cortes históricos importados del sistema anterior) ─
-- Un corte "por rango" se recalcula de `pagos`. Pero los cortes VIEJOS (del otro
-- sistema) no tienen sus pagos por día en SALA, así que sus números se guardan
-- FIJOS en `resumen` (jsonb). El ticket usa `resumen` si existe; si no, recalcula.
--
-- Forma del jsonb:
--   { "total_centavos": n,
--     "por_concepto": [{"label":"Membresías","centavos":n}, ...],
--     "por_metodo":   [{"label":"Efectivo","centavos":n}, ...] }

ALTER TABLE cortes_caja ADD COLUMN IF NOT EXISTS resumen jsonb;

-- Self-test (tabla)
SELECT 'columna cortes_caja.resumen existe' AS prueba,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'cortes_caja' AND column_name = 'resumen') AS pasa;