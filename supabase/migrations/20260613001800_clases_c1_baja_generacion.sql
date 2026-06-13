-- ============================================================================
-- MODELO VIRTUAL — C1: baja de la generación + limpieza de datos.
-- ----------------------------------------------------------------------------
-- Cierre del rediseño: el horario es la única fuente de verdad; las clases se
-- calculan al vuelo (expandir_clases) y se materializan solo al reservar/editar/
-- cancelar. Ya nada necesita pre-generar.
--
-- C1 hace:
--   1) Borra las clases 'recurrente' FUTURAS que no hacen falta (sin reservas,
--      sin lista de espera, sin override) → vuelven a ser virtuales. Conserva
--      todo lo que tenga reservas, lista de espera, sea 'manual' o
--      'recurrente_modificada', esté cancelada, o sea pasada.
--      El filtro "cero reservas y cero lista de espera" evita cualquier conflicto
--      de FK (no se borra ninguna fila referenciada).
--   2) Baja las funciones de generación (generar_clases_recurrentes y el wrapper
--      generar_mis_clases_recurrentes del botón). El cron Edge "regenerar-clases"
--      hay que DESPROGRAMARLO en Supabase (config externa, fuera de esta migración).
-- ============================================================================

-- 1) LIMPIEZA — borrar clases recurrente futuras sin uso.
DO $$
DECLARE v_n integer;
BEGIN
  DELETE FROM clases c
  WHERE c.origen = 'recurrente'
    AND c.status = 'programada'
    AND c.horario_recurrente_id IS NOT NULL
    AND c.fecha > CURRENT_DATE
    AND NOT EXISTS (SELECT 1 FROM reservas r       WHERE r.clase_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM lista_espera le  WHERE le.clase_id = c.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'C1: % clases recurrente futuras sin uso eliminadas (ahora virtuales).', v_n;
END $$;

-- 2) BAJA de la generación.
DROP FUNCTION IF EXISTS generar_mis_clases_recurrentes();
DROP FUNCTION IF EXISTS generar_clases_recurrentes(uuid, integer);

-- ============================================================================
-- TEST — no quedan clases recurrente futuras sin uso, y las funciones de
-- generación ya no existen.
-- ============================================================================
DO $$
DECLARE v_sobrantes integer; v_fns integer;
BEGIN
  SELECT count(*) INTO v_sobrantes
  FROM clases c
  WHERE c.origen = 'recurrente'
    AND c.status = 'programada'
    AND c.horario_recurrente_id IS NOT NULL
    AND c.fecha > CURRENT_DATE
    AND NOT EXISTS (SELECT 1 FROM reservas r      WHERE r.clase_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM lista_espera le WHERE le.clase_id = c.id);
  IF v_sobrantes > 0 THEN
    RAISE EXCEPTION 'TEST FALLO: quedan % clases recurrente futuras sin uso.', v_sobrantes;
  END IF;

  SELECT count(*) INTO v_fns FROM pg_proc
  WHERE proname IN ('generar_clases_recurrentes', 'generar_mis_clases_recurrentes');
  IF v_fns > 0 THEN
    RAISE EXCEPTION 'TEST FALLO: las funciones de generación siguen existiendo (%).', v_fns;
  END IF;

  RAISE NOTICE 'TEST OK: limpieza hecha y generación dada de baja. El horario es la única fuente de verdad.';
END $$;
