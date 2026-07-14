-- ============================================================================
-- REGRESIÓN: el check-in perdió el guard de sucursal
-- ----------------------------------------------------------------------------
-- 20260619320000_checkin_por_sucursal.sql ató la recepción a su sede: una
-- recepcionista de la sede A no puede hacer check-in de una reserva de la sede B.
--
-- 20260714140000_config_que_si_se_usa.sql recreó las DOS funciones de check-in
-- (CREATE OR REPLACE, para leer la ventana de la config) copiando el cuerpo... y
-- en la copia se perdió el guard. Desde entonces, en producción, cualquier
-- recepcionista puede checar reservas de cualquier sede.
--
-- Y no es la primera vez: 20260613001900_fix_max_invitados_tier.sql documenta el
-- mismo accidente con otra regla. Las funciones largas recreadas a mano pierden
-- guards en silencio. Así que acá el guard NO se copia: vive en un helper, las
-- funciones lo LLAMAN, y al final hay un self-test que falla si alguna de las dos
-- dejó de llamarlo. La próxima recreación descuidada rompe la migración, no la
-- seguridad.
-- ============================================================================

-- ── El guard, en un solo lugar ──────────────────────────────────────────────
-- La recepción está atada a su sede. El admin no (ve toda la cadena), y el staff
-- tampoco tiene sede propia. Si cualquiera de los dos lados no tiene sucursal
-- asignada (gym de una sola sede), no hay nada que comparar y pasa.
CREATE OR REPLACE FUNCTION _guard_sucursal_staff(p_recurso_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff_suc uuid;
  v_recurso_suc uuid;
BEGIN
  IF get_my_rol() <> 'recepcionista' THEN
    RETURN;
  END IF;

  SELECT sucursal_id INTO v_staff_suc FROM usuarios WHERE id = get_my_user_id();
  SELECT sucursal_id INTO v_recurso_suc FROM recursos WHERE id = p_recurso_id;

  IF v_staff_suc IS NOT NULL
     AND v_recurso_suc IS NOT NULL
     AND v_staff_suc <> v_recurso_suc THEN
    RAISE EXCEPTION 'SUCURSAL_DIFERENTE: Esta reserva es de otra sede';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION _guard_sucursal_staff(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION _guard_sucursal_staff(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION _guard_sucursal_staff(uuid) TO authenticated;

-- ── 1) Check-in por QR ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_in_atomic(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_min integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  PERFORM _guard_sucursal_staff(v_reserva.recurso_id);

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  -- La ventana la decide el GYM (Ajustes → Reglas), no el código.
  v_ventana_min := ventana_check_in_min(v_tenant_id);
  v_ventana_inicio := v_reserva.slot_inicio - (v_ventana_min || ' minutes')::interval;
  v_ventana_fin := v_reserva.slot_fin + (v_ventana_min * 2 || ' minutes')::interval;

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in abre % min antes (a las %)',
      v_ventana_min, to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'DEMASIADO_TARDE: El check-in cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'qr'
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  IF v_rol IN ('recepcionista', 'admin') THEN
    PERFORM _audrec_log(
      'checkin.qr', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
      format('Check-in QR de %s', to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI')),
      jsonb_build_object('method', 'qr')
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

-- ── 2) Check-in manual ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_in_manual_atomic(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_min integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  PERFORM _guard_sucursal_staff(v_reserva.recurso_id);

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in';
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Reserva cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Reserva marcada como inasistencia';
  END IF;

  v_ventana_min := ventana_check_in_min(v_tenant_id);
  v_ventana_inicio := v_reserva.slot_inicio - (v_ventana_min * 2 || ' minutes')::interval;
  v_ventana_fin := v_reserva.slot_fin + (v_ventana_min * 4 || ' minutes')::interval;

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in manual abre % min antes (a las %)',
      v_ventana_min * 2, to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'DEMASIADO_TARDE: El check-in manual cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'manual',
      notas = COALESCE(notas, '') ||
              CASE WHEN p_motivo IS NOT NULL
                   THEN E'\n[Check-in manual: ' || p_motivo || ']'
                   ELSE E'\n[Check-in manual]'
              END
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  IF v_rol IN ('recepcionista', 'admin') THEN
    PERFORM _audrec_log(
      'checkin.manual', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
      format('Check-in manual de %s.%s',
             to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
             CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                  THEN ' Motivo: ' || p_motivo ELSE '' END),
      jsonb_build_object('method', 'manual', 'motivo', p_motivo)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_in_atomic(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION check_in_manual_atomic(uuid, text) TO authenticated;


-- ============================================================================
-- SELF-TEST: el guard tiene que estar LLAMADO en las dos funciones.
-- Si una futura recreación lo pierde, esta migración falla y nos enteramos acá,
-- no cuando una sede chequee gente de otra.
-- ============================================================================
DO $$
DECLARE
  v_falta text[] := ARRAY[]::text[];
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['check_in_atomic', 'check_in_manual_atomic'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = v_fn
        AND p.prosrc LIKE '%_guard_sucursal_staff%'
    ) THEN
      v_falta := array_append(v_falta, v_fn);
    END IF;
  END LOOP;

  IF array_length(v_falta, 1) > 0 THEN
    RAISE EXCEPTION 'GUARD_PERDIDO: estas funciones no llaman a _guard_sucursal_staff: %',
      array_to_string(v_falta, ', ');
  END IF;
END;
$$;

-- Resultado visible (el editor esconde los NOTICE, así que devolvemos tabla).
SELECT
  p.proname AS prueba,
  'llama al guard de sucursal' AS espera,
  CASE WHEN p.prosrc LIKE '%_guard_sucursal_staff%' THEN 'OK' ELSE 'FALLA' END AS resultado
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('check_in_atomic', 'check_in_manual_atomic')
ORDER BY p.proname;
