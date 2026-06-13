-- ============================================================================
-- MODELO VIRTUAL — B1b: editar_clase_override (editar un día puntual).
-- ----------------------------------------------------------------------------
-- Editar UNA instancia (no la regla) desde Agenda: materializa la clase si es
-- virtual, escribe los campos editados y la marca origen='recurrente_modificada'
-- → la expansión usa estos campos para esa fecha y deja de leer la regla (solo
-- para ese día). Editar la REGLA (Horarios) sigue propagando a las no-override.
-- ============================================================================

-- Agregar 'clase.editar' al enum de acciones de la bitácora.
ALTER TABLE auditoria_recepcion DROP CONSTRAINT IF EXISTS auditoria_recepcion_accion_check;
ALTER TABLE auditoria_recepcion ADD CONSTRAINT auditoria_recepcion_accion_check
  CHECK (accion IN (
    'membresia.renovar','membresia.cambiar_plan','membresia.recargar_creditos',
    'membresia.congelar','membresia.reactivar','membresia.cancelar',
    'reserva.crear','reserva.cancelar','reserva.lista_espera_anotar','reserva.lista_espera_promover',
    'socio.crear','socio.editar_contacto','socio.reset_password','socio.bloquear','socio.desbloquear','socio.nota',
    'clase.crear','clase.cancelar','clase.editar','clase.reasignar_coach','clase.marcar_asistencia','clase.marcar_no_show',
    'pago.reenviar_link','pago.activar',
    'checkin.manual','checkin.qr','checkin.corregir'
  ));

CREATE OR REPLACE FUNCTION editar_clase_override(
  p_clase_id uuid DEFAULT NULL,
  p_horario_id uuid DEFAULT NULL,
  p_fecha date DEFAULT NULL,
  p_nombre text DEFAULT NULL,
  p_descripcion text DEFAULT NULL,
  p_cupo_max integer DEFAULT NULL,
  p_duracion_minutos integer DEFAULT NULL,
  p_instructor_id uuid DEFAULT NULL,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_clase_id uuid;
  v_clase clases;
  v_reservados integer;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden editar una clase';
  END IF;

  IF p_clase_id IS NOT NULL THEN
    v_clase_id := p_clase_id;
  ELSIF p_horario_id IS NOT NULL AND p_fecha IS NOT NULL THEN
    v_clase_id := materializar_clase(p_horario_id, p_fecha);
  ELSE
    RAISE EXCEPTION 'PARAMS: se requiere p_clase_id o (p_horario_id, p_fecha)';
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_clase_id;
  IF v_clase.id IS NULL THEN RAISE EXCEPTION 'CLASE_NO_EXISTE: no encontramos esa clase'; END IF;
  IF v_clase.tenant_id <> v_tenant THEN RAISE EXCEPTION 'TENANT_MISMATCH: esa clase no pertenece a tu gimnasio'; END IF;
  IF v_clase.status = 'cancelada' THEN RAISE EXCEPTION 'CLASE_CANCELADA: no se puede editar una clase cancelada'; END IF;

  IF p_duracion_minutos IS NOT NULL AND p_duracion_minutos <= 0 THEN
    RAISE EXCEPTION 'DURACION_INVALIDA: la duración debe ser mayor a 0';
  END IF;

  -- No permitir bajar el cupo por debajo de lo ya reservado.
  IF p_cupo_max IS NOT NULL THEN
    SELECT count(*) INTO v_reservados FROM reservas
      WHERE clase_id = v_clase_id AND status IN ('confirmada','completada');
    IF p_cupo_max < v_reservados THEN
      RAISE EXCEPTION 'CUPO_MENOR_QUE_RESERVADOS: ya hay % reservas; el cupo no puede ser menor', v_reservados;
    END IF;
    IF p_cupo_max <= 0 THEN
      RAISE EXCEPTION 'CUPO_INVALIDO: el cupo debe ser mayor a 0';
    END IF;
  END IF;

  -- Override: campos editados (COALESCE = solo lo que vino) y, si era una
  -- instancia de regla, se vuelve 'recurrente_modificada' (las 'manual' siguen).
  UPDATE clases
  SET nombre = COALESCE(p_nombre, nombre),
      descripcion = COALESCE(p_descripcion, descripcion),
      cupo_max = COALESCE(p_cupo_max, cupo_max),
      duracion_minutos = COALESCE(p_duracion_minutos, duracion_minutos),
      instructor_id = p_instructor_id,
      origen = CASE WHEN origen = 'recurrente' THEN 'recurrente_modificada' ELSE origen END,
      updated_at = now()
  WHERE id = v_clase_id;

  PERFORM _audrec_log(
    'clase.editar', 'clase', v_clase_id, NULL, NULL,
    format('Editó la clase "%s" del %s.%s',
           COALESCE(p_nombre, v_clase.nombre), v_clase.fecha,
           CASE WHEN NULLIF(trim(COALESCE(p_motivo,'')),'') IS NOT NULL THEN ' Motivo: '||p_motivo ELSE '' END),
    jsonb_build_object('clase_id', v_clase_id, 'fecha', v_clase.fecha, 'motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'clase_id', v_clase_id);
END $$;

REVOKE ALL ON FUNCTION editar_clase_override(uuid, uuid, date, text, text, integer, integer, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION editar_clase_override(uuid, uuid, date, text, text, integer, integer, uuid, text) TO authenticated;

-- ============================================================================
-- TEST — editar una virtual la materializa como override (recurrente_modificada)
-- con el nombre nuevo. Savepoint + centinela. SKIP sin recep/horario.
-- ============================================================================
DO $$
DECLARE
  v_recep_auth uuid; v_tenant uuid; v_horario uuid; v_dow int; v_fecha date;
  v_clase_id uuid; v_origen text; v_nombre text; v_n int;
BEGIN
  SELECT auth_id, tenant_id INTO v_recep_auth, v_tenant
  FROM usuarios WHERE rol IN ('recepcionista','admin') AND auth_id IS NOT NULL LIMIT 1;
  IF v_recep_auth IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay staff con auth_id.'; RETURN; END IF;

  SELECT id, dias_semana[1] INTO v_horario, v_dow
  FROM horarios_recurrentes WHERE tenant_id = v_tenant AND activo LIMIT 1;
  IF v_horario IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay horario activo.'; RETURN; END IF;

  v_fecha := (CURRENT_DATE + 70) + ((v_dow - EXTRACT(DOW FROM CURRENT_DATE + 70)::int + 7) % 7);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);

  BEGIN
    PERFORM editar_clase_override(NULL, v_horario, v_fecha, 'Nombre Editado Test', NULL, NULL, NULL, NULL, 'Test');

    SELECT count(*) INTO v_n FROM clases WHERE horario_recurrente_id = v_horario AND fecha = v_fecha;
    SELECT origen, nombre INTO v_origen, v_nombre
      FROM clases WHERE horario_recurrente_id = v_horario AND fecha = v_fecha;

    IF v_n <> 1 THEN RAISE EXCEPTION 'TEST FALLO: se crearon % filas (esperaba 1).', v_n; END IF;
    IF v_origen <> 'recurrente_modificada' THEN RAISE EXCEPTION 'TEST FALLO: origen quedó % (esperaba recurrente_modificada).', v_origen; END IF;
    IF v_nombre <> 'Nombre Editado Test' THEN RAISE EXCEPTION 'TEST FALLO: el nombre no se editó (%).', v_nombre; END IF;

    RAISE EXCEPTION 'ROLLBACK_B1B';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_B1B' THEN NULL; ELSE RAISE; END IF;
  END;

  RAISE NOTICE 'TEST OK: editar_clase_override materializa la virtual como override (recurrente_modificada) con el nombre nuevo. Revertido.';
END $$;
