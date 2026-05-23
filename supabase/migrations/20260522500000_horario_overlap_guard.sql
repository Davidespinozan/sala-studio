-- ============================================================================
-- Item 4 — guard de solapamiento de horarios recurrentes (backend)
-- ============================================================================
-- Hoy se pueden crear dos horarios_recurrentes en la misma sala que se pisan
-- en día + hora → la generación produce dos clases distintas en la misma sala
-- al mismo tiempo (físicamente imposible).
--
-- El front ya valida el solape antes de guardar (UX). Esto es la defensa real
-- a nivel base: un trigger BEFORE INSERT/UPDATE que rechaza el solape, cubra
-- el camino que cubra (front, API directa, código futuro).
--
-- POR QUÉ TRIGGER (y no constraint ni RPC):
--   - Constraint: una EXCLUSION constraint no puede expresar "los arrays
--     dias_semana[] se intersectan Y los rangos horarios se pisan" con el
--     schema actual (día como array). Inviable.
--   - RPC: solo protegería a quien llame el RPC. El front hoy hace INSERT/
--     UPDATE directos; habría que reescribirlo y aun así no cubriría escrituras
--     directas a la tabla.
--   - Trigger: cubre TODA escritura a horarios_recurrentes, sin tocar el front.
--
-- DEFINICIÓN DE SOLAPE (igual que la lógica del front):
--   misma sala (recurso_id) + días que se cruzan (operador && de arrays) +
--   rangos [inicio, inicio+duración) que se pisan. Borde exclusivo:
--   fin == inicio NO es solape (horarios adyacentes permitidos).
--
-- Solo aplica a horarios ACTIVOS — uno inactivo no genera clases. Al hacer
-- UPDATE, el horario se excluye a sí mismo (h.id <> NEW.id).
--
-- NO revisa filas ya existentes: el trigger solo corre en INSERT/UPDATE. Si
-- hubiera solapes viejos en la BD, siguen ahí hasta que alguien los edite.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_validar_solape_horario()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conflicto_nombre text;
BEGIN
  -- Un horario inactivo no genera clases → no puede entrar en conflicto.
  IF NEW.activo IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Tiempo en segundos desde medianoche (EXTRACT EPOCH) — evita el wrap de
  -- 'time + interval' si un horario cruzara medianoche. Solape de intervalos
  -- medio-abiertos: aIni < bFin AND bIni < aFin.
  SELECT h.nombre
    INTO v_conflicto_nombre
  FROM horarios_recurrentes h
  WHERE h.recurso_id = NEW.recurso_id
    AND h.id <> NEW.id
    AND h.activo = true
    AND h.dias_semana && NEW.dias_semana
    AND EXTRACT(EPOCH FROM h.hora_inicio)
        < EXTRACT(EPOCH FROM NEW.hora_inicio) + NEW.duracion_minutos * 60
    AND EXTRACT(EPOCH FROM NEW.hora_inicio)
        < EXTRACT(EPOCH FROM h.hora_inicio) + h.duracion_minutos * 60
  ORDER BY h.hora_inicio
  LIMIT 1;

  IF v_conflicto_nombre IS NOT NULL THEN
    RAISE EXCEPTION 'HORARIO_SOLAPADO: Este horario se solapa con "%" en la misma sala.', v_conflicto_nombre;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION trg_validar_solape_horario() FROM PUBLIC;

DROP TRIGGER IF EXISTS horarios_rec_validar_solape ON horarios_recurrentes;
CREATE TRIGGER horarios_rec_validar_solape
  BEFORE INSERT OR UPDATE ON horarios_recurrentes
  FOR EACH ROW
  EXECUTE FUNCTION trg_validar_solape_horario();

DO $$
BEGIN
  RAISE NOTICE 'Guard de solape de horarios OK: trigger horarios_rec_validar_solape activo.';
END $$;
