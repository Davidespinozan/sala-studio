-- ── Fix: materializar_clase chocaba con clases_unique_slot ────────────────────
-- Síntoma real: al reservar, "duplicate key value violates unique constraint
-- clases_unique_slot".
--
-- Causa: el índice único es por SLOT (tenant_id, recurso_id, fecha, hora_inicio)
-- WHERE status<>'cancelada', pero materializar_clase solo revisaba si ya existía
-- una clase con ESE horario_recurrente_id. Si el slot ya estaba ocupado por una
-- clase de OTRO horario (p.ej. tras editar el horario → nuevo horario_id, pero
-- quedó la clase vieja materializada en el hueco), el chequeo fallaba y el INSERT
-- chocaba con el índice.
--
-- Cambio QUIRÚRGICO (el camino normal no cambia; solo se agrega manejo gracioso):
--   1) chequeo por horario_id (igual que antes, camino rápido);
--   2) si el SLOT ya tiene una clase no cancelada (aunque sea de otro horario),
--      se ADOPTA esa en vez de chocar;
--   3) el INSERT atrapa unique_violation (carrera entre dos reservas) y adopta
--      la clase que ganó.

CREATE OR REPLACE FUNCTION materializar_clase(
  p_horario_id uuid,
  p_fecha date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_clase_id uuid;
  v_recurso uuid;
  v_hora time;
BEGIN
  -- 1) ¿Ya existe la instancia de ESE horario en esa fecha? (camino normal)
  SELECT id INTO v_clase_id
  FROM clases
  WHERE horario_recurrente_id = p_horario_id
    AND fecha = p_fecha
    AND tenant_id = v_tenant;
  IF v_clase_id IS NOT NULL THEN
    RETURN v_clase_id;
  END IF;

  -- Slot (recurso/hora) de este horario, para detectar colisiones.
  SELECT hr.recurso_id, hr.hora_inicio INTO v_recurso, v_hora
  FROM horarios_recurrentes hr
  WHERE hr.id = p_horario_id AND hr.tenant_id = v_tenant;

  -- 2) ¿Ya hay una clase NO cancelada en el MISMO slot (aunque venga de otro
  --    horario)? Adoptarla en vez de chocar con clases_unique_slot.
  IF v_recurso IS NOT NULL THEN
    SELECT id INTO v_clase_id
    FROM clases
    WHERE tenant_id = v_tenant AND recurso_id = v_recurso
      AND fecha = p_fecha AND hora_inicio = v_hora
      AND status <> 'cancelada'
    LIMIT 1;
    IF v_clase_id IS NOT NULL THEN
      RETURN v_clase_id;
    END IF;
  END IF;

  -- 3) Insertar la instancia nueva (con red de seguridad contra carreras).
  BEGIN
    INSERT INTO clases (
      tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos,
      nombre, disciplina, descripcion, foto_url,
      cupo_max, instructor_id, origen, horario_recurrente_id, status
    )
    SELECT
      hr.tenant_id, hr.sucursal_id, hr.recurso_id, p_fecha, hr.hora_inicio, hr.duracion_minutos,
      hr.nombre,
      COALESCE(hr.disciplina, (r.tipo_contenido)[1]),
      hr.descripcion,
      hr.foto_url,
      COALESCE(hr.cupo_max, r.cupo_max_default),
      hr.instructor_id, 'recurrente', hr.id, 'programada'
    FROM horarios_recurrentes hr
    JOIN recursos   r ON r.id = hr.recurso_id
    JOIN sucursales s ON s.id = hr.sucursal_id
    WHERE hr.id = p_horario_id
      AND hr.tenant_id = v_tenant
      AND hr.activo
      AND r.activo
    RETURNING id INTO v_clase_id;
  EXCEPTION WHEN unique_violation THEN
    -- Carrera: otra reserva materializó el mismo slot entre el chequeo y el
    -- insert. Adoptar la clase que ganó en vez de fallar.
    SELECT id INTO v_clase_id
    FROM clases
    WHERE tenant_id = v_tenant AND recurso_id = v_recurso
      AND fecha = p_fecha AND hora_inicio = v_hora
      AND status <> 'cancelada'
    LIMIT 1;
  END;

  IF v_clase_id IS NULL THEN
    RAISE EXCEPTION 'HORARIO_NO_EXISTE: El horario no existe, no está activo, o su sala está inactiva';
  END IF;

  RETURN v_clase_id;
END;
$$;

REVOKE ALL ON FUNCTION materializar_clase(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION materializar_clase(uuid, date) TO authenticated;

-- Self-test (tabla): la función tiene el adopta-slot + red de carrera.
SELECT
  (position('unique_violation' in p.prosrc) > 0) AS maneja_carrera,
  (position('status <> ''cancelada''' in p.prosrc) > 0) AS adopta_slot
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'materializar_clase';