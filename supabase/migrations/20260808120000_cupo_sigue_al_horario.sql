-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- EL CUPO DE LA CLASE SIGUE AL HORARIO (aunque la clase esté "modificada")
-- ────────────────────────────────────────────────────────────────────────────
-- Problema: al editar una clase puntual (nombre/hora/instructor), se materializa
-- como 'recurrente_modificada' y CONGELA su cupo. Luego cambiar el cupo del
-- horario NO la actualiza → cupos mezclados (unas 13, otras 15/20).
--
-- Arreglo: un trigger en horarios_recurrentes. Cuando cambia cupo_max del horario,
-- propaga el nuevo cupo a sus clases FUTURAS que iban EN SINCRONÍA con la regla
-- (su cupo == el cupo efectivo viejo del horario). Las que tienen un cupo DISTINTO
-- (un override explícito) NO se tocan. Y nunca baja por debajo de lo ya reservado.
--
-- Por qué así y no cupo_max nullable: mantener el cupo como número concreto no
-- toca la ruta de capacidad/reservas (zona de dinero) — cero riesgo ahí.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION _propagar_cupo_horario()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo si el cupo REALMENTE cambió (el form puede reenviar el mismo).
  IF NEW.cupo_max IS DISTINCT FROM OLD.cupo_max THEN
    UPDATE clases c
    SET cupo_max = GREATEST(
          -- cupo efectivo nuevo del horario (si NULL, el default de la sala)
          COALESCE(NEW.cupo_max, rd.cupo_max_default),
          -- piso: nunca por debajo de lo ya reservado
          (SELECT count(*) FROM reservas r
           WHERE r.clase_id = c.id AND r.status IN ('confirmada','completada'))
        )
    FROM recursos rd
    WHERE c.recurso_id = rd.id
      AND c.horario_recurrente_id = NEW.id
      AND c.fecha >= CURRENT_DATE
      AND c.status <> 'cancelada'
      -- solo las que iban en sincronía con la regla (cupo == efectivo viejo);
      -- las que tienen un cupo distinto son override explícito → se respetan.
      AND c.cupo_max = COALESCE(OLD.cupo_max, rd.cupo_max_default);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS horario_propaga_cupo ON horarios_recurrentes;
CREATE TRIGGER horario_propaga_cupo
  AFTER UPDATE OF cupo_max ON horarios_recurrentes
  FOR EACH ROW EXECUTE FUNCTION _propagar_cupo_horario();

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — se auto-verifica y revierte. Cambia el cupo de un horario real de numa y
-- comprueba que una de sus clases futuras (en sincronía) siguió el cambio. Revierte.
-- El SELECT final devuelve TABLA.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_horario uuid; v_recurso uuid; v_default int;
  v_clase uuid; v_antes int; v_efectivo_viejo int; v_despues int;
BEGIN
  SELECT h.id, h.recurso_id INTO v_horario, v_recurso
  FROM horarios_recurrentes h JOIN tenants t ON t.id = h.tenant_id
  WHERE t.slug = 'numawellness'
    AND EXISTS (SELECT 1 FROM clases c
                WHERE c.horario_recurrente_id = h.id AND c.fecha >= CURRENT_DATE
                  AND c.status <> 'cancelada')
  LIMIT 1;
  IF v_horario IS NULL THEN RAISE NOTICE 'TEST SKIP: sin horario con clases futuras.'; RETURN; END IF;

  SELECT cupo_max_default INTO v_default FROM recursos WHERE id = v_recurso;
  SELECT COALESCE((SELECT cupo_max FROM horarios_recurrentes WHERE id = v_horario), v_default)
    INTO v_efectivo_viejo;

  -- una clase futura que va en sincronía con la regla
  SELECT id, cupo_max INTO v_clase, v_antes
  FROM clases
  WHERE horario_recurrente_id = v_horario AND fecha >= CURRENT_DATE
    AND status <> 'cancelada' AND cupo_max = v_efectivo_viejo
  ORDER BY fecha
  LIMIT 1;
  IF v_clase IS NULL THEN RAISE NOTICE 'TEST SKIP: sin clase en sincronía.'; RETURN; END IF;

  -- Cambiar el cupo del horario a efectivo+1 → debe propagar a la clase.
  UPDATE horarios_recurrentes SET cupo_max = v_efectivo_viejo + 1 WHERE id = v_horario;

  SELECT cupo_max INTO v_despues FROM clases WHERE id = v_clase;
  IF v_despues <> v_efectivo_viejo + 1 THEN
    RAISE EXCEPTION 'TEST FALLO: la clase no siguió al horario (antes=% despues=% esperado=%).',
      v_antes, v_despues, v_efectivo_viejo + 1;
  END IF;

  RAISE EXCEPTION 'ROLLBACK_CUPO_OK';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_CUPO_OK' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT
  'cupo de clase sigue al horario' AS prueba,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'horario_propaga_cupo') AS trigger_ok,
  (SELECT count(*) FROM pg_proc WHERE proname = '_propagar_cupo_horario') AS funcion_ok;