-- ============================================================================
-- MODELO VIRTUAL DE CLASES — A1: materialización al reservar.
-- ----------------------------------------------------------------------------
-- Una clase virtual no tiene fila en `clases` hasta que hace falta. Cuando un
-- socio reserva (o se anota en lista de espera) una instancia virtual, primero
-- la MATERIALIZAMOS (creamos la fila desde la regla, idempotente vía el índice
-- único de F0) y después delegamos a la RPC existente por clase_id.
--
--   materializar_clase(horario, fecha) → uuid (privada; la usan los wrappers)
--   reservar_clase_virtual(horario, fecha, invitados, notas) → reservar_clase_atomic
--   anotar_lista_espera_virtual(horario, fecha)              → anotar_lista_espera
--
-- Las RPCs viejas por clase_id NO se tocan (las clases 'manual' y las ya
-- materializadas las siguen usando). Esto es aditivo.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- materializar_clase — crea (o devuelve) la fila de clase de una (regla, fecha).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION materializar_clase(
  p_horario_id uuid,
  p_fecha date
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_clase_id uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: usuario no autenticado';
  END IF;

  -- Materializa desde la regla (solo si la regla es válida y la fecha cae en
  -- dias_semana). ON CONFLICT (horario_recurrente_id, fecha) la hace idempotente.
  INSERT INTO clases (
    tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos,
    nombre, disciplina, cupo_max, instructor_id, origen, horario_recurrente_id, status
  )
  SELECT
    hr.tenant_id, hr.sucursal_id, hr.recurso_id, p_fecha, hr.hora_inicio, hr.duracion_minutos,
    hr.nombre, (r.tipo_contenido)[1], COALESCE(hr.cupo_max, r.cupo_max_default),
    hr.instructor_id, 'recurrente', hr.id, 'programada'
  FROM horarios_recurrentes hr
  JOIN recursos   r ON r.id = hr.recurso_id
  JOIN sucursales s ON s.id = hr.sucursal_id
  WHERE hr.id = p_horario_id
    AND hr.tenant_id = v_tenant
    AND hr.activo
    AND r.activo
    AND s.activa
    AND EXTRACT(DOW FROM p_fecha)::int = ANY(hr.dias_semana)
  -- El índice único de F0 es PARCIAL (WHERE horario_recurrente_id IS NOT NULL);
  -- hay que repetir su predicado para que el ON CONFLICT lo infiera.
  ON CONFLICT (horario_recurrente_id, fecha) WHERE horario_recurrente_id IS NOT NULL DO NOTHING;

  -- Recuperar el id (recién insertado o pre-existente). NULL = la (regla, fecha)
  -- no es una instancia válida.
  SELECT id INTO v_clase_id
  FROM clases
  WHERE horario_recurrente_id = p_horario_id AND fecha = p_fecha;

  IF v_clase_id IS NULL THEN
    RAISE EXCEPTION 'CLASE_VIRTUAL_INVALIDA: no existe una clase de ese horario en esa fecha (regla inactiva, fecha fuera de dias_semana, o de otro gimnasio)';
  END IF;

  RETURN v_clase_id;
END $$;

REVOKE ALL ON FUNCTION materializar_clase(uuid, date) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- reservar_clase_virtual — materializa y delega en reservar_clase_atomic.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reservar_clase_virtual(
  p_horario_id uuid,
  p_fecha date,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clase_id uuid;
BEGIN
  v_clase_id := materializar_clase(p_horario_id, p_fecha);
  RETURN reservar_clase_atomic(v_clase_id, p_invitados, p_notas);
END $$;

REVOKE ALL ON FUNCTION reservar_clase_virtual(uuid, date, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reservar_clase_virtual(uuid, date, integer, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- anotar_lista_espera_virtual — materializa y delega en anotar_lista_espera.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION anotar_lista_espera_virtual(
  p_horario_id uuid,
  p_fecha date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clase_id uuid;
BEGIN
  v_clase_id := materializar_clase(p_horario_id, p_fecha);
  RETURN anotar_lista_espera(v_clase_id);
END $$;

REVOKE ALL ON FUNCTION anotar_lista_espera_virtual(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION anotar_lista_espera_virtual(uuid, date) TO authenticated;

-- ============================================================================
-- TEST — materializar es idempotente y crea la fila correcta. Savepoint.
-- ============================================================================
DO $$
DECLARE
  v_staff_auth uuid; v_tenant uuid;
  v_horario uuid; v_dow int; v_fecha date;
  v_id1 uuid; v_id2 uuid; v_count int;
BEGIN
  SELECT auth_id, tenant_id INTO v_staff_auth, v_tenant
  FROM usuarios WHERE rol IN ('recepcionista','admin') AND auth_id IS NOT NULL LIMIT 1;
  IF v_staff_auth IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay staff con auth_id.';
    RETURN;
  END IF;

  SELECT id, dias_semana[1] INTO v_horario, v_dow
  FROM horarios_recurrentes WHERE tenant_id = v_tenant AND activo LIMIT 1;
  IF v_horario IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay horario recurrente activo.';
    RETURN;
  END IF;

  -- Fecha ~70 días out (más allá de la generación de 60 días) cuyo DOW = v_dow:
  -- así es una instancia VIRTUAL de verdad y el test ejercita el INSERT real,
  -- no una clase ya materializada.
  v_fecha := (CURRENT_DATE + 70)
           + ((v_dow - EXTRACT(DOW FROM CURRENT_DATE + 70)::int + 7) % 7);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff_auth::text)::text, true);

  BEGIN
    v_id1 := materializar_clase(v_horario, v_fecha);
    v_id2 := materializar_clase(v_horario, v_fecha);  -- idempotente

    IF v_id1 IS NULL OR v_id1 <> v_id2 THEN
      RAISE EXCEPTION 'TEST FALLO: materializar no es idempotente (id1=%, id2=%).', v_id1, v_id2;
    END IF;

    SELECT count(*) INTO v_count
    FROM clases WHERE horario_recurrente_id = v_horario AND fecha = v_fecha;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'TEST FALLO: se crearon % filas para (horario,fecha) (esperaba 1).', v_count;
    END IF;

    RAISE EXCEPTION 'ROLLBACK_A1';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_A1' THEN NULL;
    ELSE RAISE; END IF;
  END;

  RAISE NOTICE 'TEST OK: materializar_clase es idempotente y crea 1 fila por (horario,fecha). Revertido.';
END $$;
