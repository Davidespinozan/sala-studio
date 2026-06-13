-- ============================================================================
-- MODELO VIRTUAL DE CLASES — F0: preparación de esquema.
-- ----------------------------------------------------------------------------
-- Paso previo al rediseño "el horario es la única fuente de verdad; las clases
-- se calculan al vuelo y se materializan solo al reservar/editar/cancelar".
--
-- F0 NO cambia comportamiento todavía. Hace dos cosas:
--   1) BACKFILL: vincula las clases 'recurrente'/'recurrente_modificada' legacy
--      (horario_recurrente_id NULL, de la primera generación) a su regla actual,
--      para que la RPC de expansión (F1) las trate como la instancia
--      materializada de ese (horario, fecha) — sin duplicarlas ni perder sus
--      reservas. El match es por (tenant, sucursal, recurso, hora_inicio) + que
--      el día de la fecha caiga en dias_semana de la regla.
--   2) ÍNDICE ÚNICO (horario_recurrente_id, fecha): permite materializar de forma
--      idempotente (INSERT ... ON CONFLICT) y buscar el override de una regla en
--      una fecha en O(1). Solo aplica a filas con horario_recurrente_id (las
--      'manual' ad-hoc quedan fuera).
-- ============================================================================

-- 1) BACKFILL — vincular legacy a su regla.
DO $$
DECLARE v_n integer;
BEGIN
  UPDATE clases c
  SET horario_recurrente_id = hr.id
  FROM horarios_recurrentes hr
  WHERE c.horario_recurrente_id IS NULL
    AND c.origen IN ('recurrente', 'recurrente_modificada')
    AND hr.tenant_id   = c.tenant_id
    AND hr.sucursal_id = c.sucursal_id
    AND hr.recurso_id  = c.recurso_id
    AND hr.hora_inicio = c.hora_inicio
    AND EXTRACT(DOW FROM c.fecha)::int = ANY(hr.dias_semana);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'F0 backfill: % clases legacy vinculadas a su horario.', v_n;
END $$;

-- 2) GUARD anti-duplicados antes del índice único.
DO $$
DECLARE v_dups integer;
BEGIN
  SELECT count(*) INTO v_dups FROM (
    SELECT horario_recurrente_id, fecha
    FROM clases
    WHERE horario_recurrente_id IS NOT NULL
    GROUP BY horario_recurrente_id, fecha
    HAVING count(*) > 1
  ) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION 'F0 ABORT: % pares (horario,fecha) duplicados en clases. Hay que resolverlos antes del índice único (posible regla con dias_semana solapados).', v_dups;
  END IF;
END $$;

-- 3) ÍNDICE ÚNICO — una instancia materializada por (regla, fecha).
CREATE UNIQUE INDEX IF NOT EXISTS clases_horario_fecha_unico
  ON clases (horario_recurrente_id, fecha)
  WHERE horario_recurrente_id IS NOT NULL;

COMMENT ON INDEX clases_horario_fecha_unico IS
  'Modelo virtual: garantiza una sola clase materializada por (horario_recurrente_id, fecha). Habilita materialización idempotente (INSERT ... ON CONFLICT) y lookup del override de una regla en una fecha.';

-- ============================================================================
-- TEST — el índice existe y no quedan (horario,fecha) duplicados.
-- ============================================================================
DO $$
DECLARE v_dups integer; v_idx integer;
BEGIN
  SELECT count(*) INTO v_dups FROM (
    SELECT horario_recurrente_id, fecha FROM clases
    WHERE horario_recurrente_id IS NOT NULL
    GROUP BY horario_recurrente_id, fecha HAVING count(*) > 1
  ) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION 'TEST FALLO: quedan % pares (horario,fecha) duplicados.', v_dups;
  END IF;

  SELECT count(*) INTO v_idx FROM pg_indexes
  WHERE tablename = 'clases' AND indexname = 'clases_horario_fecha_unico';
  IF v_idx = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: no se creó el índice clases_horario_fecha_unico.';
  END IF;

  RAISE NOTICE 'TEST OK: F0 listo — legacy vinculadas, índice único (horario,fecha) creado.';
END $$;
