-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Envuelto en BEGIN/COMMIT: todo-o-nada. Si cualquier statement (incl. un
-- self-test) falla, se revierte la migración entera.
-- ============================================================================
BEGIN;

-- ============================================================================
-- WAVE 2 — Concurrencia / serialización de estado compartido
-- W2-01 sobreventa en salas de CUPO-POR-CONTEO · W2-02 corte de caja concurrente
-- W2-03 doble check-in (TOCTOU)
-- ----------------------------------------------------------------------------
-- W1 (idempotencia, business_operations) NO se toca. Esto es serialización de
-- recursos, no idempotencia: ningún comando recibe operation_key.
--
-- W2-01: el chequeo de cupo en salas de conteo era un SUM sin lock → dos socios
--   distintos reservando el último lugar podían pasar ambos y sobrevender. Las
--   salas con MAPA ya estaban serializadas por un advisory lock por clase. Se
--   sube ese MISMO lock a TODAS las salas (antes solo el ramo con layout), tomado
--   ANTES del cálculo de cupo y ANTES del FOR UPDATE de la membresía (mismo orden
--   que ya usaban las salas con mapa → sin deadlock).
-- W2-02: hacer_corte_caja perdió su advisory lock (v3, rango arbitrario). Se
--   reinstala un lock por (tenant) — nivel tenant, no (tenant,sucursal), porque
--   sucursal NULL = "todas las sedes" y debe entrar en conflicto con los cortes
--   por-sucursal (leen pagos que se solapan). Un solo lock por tenant ⇒ sin
--   deadlock. Los cortes solapados SIGUEN permitidos (son reportes): el lock solo
--   serializa el cálculo concurrente, no prohíbe periodos que se encimen.
-- W2-03: los check-in hacían SELECT status → IF completada RAISE → UPDATE (sin
--   predicado de status, sin lock) → dos check-in simultáneos pasaban ambos. Se
--   agrega FOR UPDATE a la lectura inicial de la reserva: el segundo bloquea, al
--   desbloquear relee el estado ya 'completada' y el guard YA_CHECK_IN lo corta.
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- W2-02 · hacer_corte_caja: serializa el cálculo/creación por tenant.
--   (verbatim de 20260813110000 + el advisory lock; overlaps siguen permitidos)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION hacer_corte_caja(
  p_desde timestamptz,
  p_hasta timestamptz,
  p_sucursal_id uuid DEFAULT NULL,
  p_efectivo_contado_centavos integer DEFAULT 0,
  p_fondo_centavos integer DEFAULT 0,
  p_notas text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_actor uuid;
  v_esperado integer; v_dif integer; v_id uuid; v_resumen jsonb;
BEGIN
  IF NOT is_recepcionista() THEN RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin'; END IF;
  v_tenant := get_my_tenant_id();
  v_actor  := get_my_user_id();

  IF p_efectivo_contado_centavos < 0 OR p_fondo_centavos < 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: los montos no pueden ser negativos';
  END IF;
  IF p_hasta <= p_desde THEN
    RAISE EXCEPTION 'RANGO_INVALIDO: la fecha final debe ser mayor que la inicial';
  END IF;
  IF p_sucursal_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'SUCURSAL_INVALIDA';
  END IF;

  -- W2-02: serializa el corte por TENANT. Nivel tenant (no sucursal) a propósito:
  -- un corte "todas las sedes" (sucursal NULL) lee los pagos de todas las
  -- sucursales, así que debe entrar en conflicto con cualquier corte por-sucursal
  -- del mismo tenant. Un único lock por tenant garantiza ese conflicto sin riesgo
  -- de deadlock. NO impide periodos solapados (los cortes son reportes): solo
  -- evita que dos cortes del mismo tenant calculen/inserten en paralelo.
  PERFORM pg_advisory_xact_lock(hashtext('corte:' || v_tenant::text));

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_esperado FROM pagos
   WHERE tenant_id = v_tenant AND metodo = 'efectivo'
     AND (p_sucursal_id IS NULL OR sucursal_id = p_sucursal_id)
     AND created_at >= p_desde AND created_at < p_hasta;

  v_dif := p_efectivo_contado_centavos - (v_esperado + p_fondo_centavos);
  v_resumen := _resumen_corte(v_tenant, p_sucursal_id, p_desde, p_hasta);

  INSERT INTO cortes_caja (
    tenant_id, sucursal_id, realizado_por, desde, hasta,
    efectivo_esperado_centavos, fondo_centavos, efectivo_contado_centavos, diferencia_centavos, notas, resumen
  ) VALUES (
    v_tenant, p_sucursal_id, v_actor, p_desde, p_hasta,
    v_esperado, p_fondo_centavos, p_efectivo_contado_centavos, v_dif, NULLIF(trim(p_notas), ''), v_resumen
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true, 'id', v_id, 'desde', p_desde, 'hasta', p_hasta,
    'efectivo_esperado_centavos', v_esperado, 'fondo_centavos', p_fondo_centavos,
    'efectivo_contado_centavos', p_efectivo_contado_centavos, 'diferencia_centavos', v_dif,
    'resumen', v_resumen
  );
END; $$;

REVOKE ALL ON FUNCTION hacer_corte_caja(timestamptz, timestamptz, uuid, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hacer_corte_caja(timestamptz, timestamptz, uuid, integer, integer, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- W2-03 · check-in atómico: FOR UPDATE en la lectura inicial de la reserva.
--   (verbatim de 20260717100000 / 20260815160000 / 20260612040000 + FOR UPDATE)
-- ════════════════════════════════════════════════════════════════════════════

-- 1) QR
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

  -- W2-03: FOR UPDATE serializa el check-in de ESTA reserva. Un segundo check-in
  -- concurrente bloquea acá, y al desbloquear relee status='completada' → corta
  -- abajo con YA_CHECK_IN (antes ambos pasaban el guard y hacían UPDATE ciego).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;

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

  PERFORM _guard_membresia_checkin(v_reserva.usuario_id);

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
    'membresia_estado', _estado_membresia_checkin(v_reserva.usuario_id),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

-- 2) Manual
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

  -- W2-03: FOR UPDATE (ver check_in_atomic).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;

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

  -- OJO: acá NO bloqueamos por membresía (política: recepción decide).

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
    'membresia_estado', _estado_membresia_checkin(v_reserva.usuario_id),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_in_atomic(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION check_in_manual_atomic(uuid, text) TO authenticated;

-- 3) Huella
CREATE OR REPLACE FUNCTION check_in_por_huella(
  p_token text,
  p_usuario_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lector lectores_biometricos;
  v_socio usuarios;
  v_reserva reservas;
  v_recurso recursos;
  v_clase clases;
  v_ventana integer;
BEGIN
  SELECT * INTO v_lector
  FROM lectores_biometricos
  WHERE token_hash = _hash_token_lector(p_token);

  IF v_lector.id IS NULL THEN
    RAISE EXCEPTION 'LECTOR_DESCONOCIDO: Ese lector no está dado de alta';
  END IF;

  IF NOT v_lector.activo THEN
    RAISE EXCEPTION 'LECTOR_INACTIVO: Ese lector está desactivado';
  END IF;

  UPDATE lectores_biometricos SET ultimo_visto_at = now() WHERE id = v_lector.id;

  SELECT u.* INTO v_socio
  FROM usuarios u
  WHERE u.id = p_usuario_id
    AND u.tenant_id = v_lector.tenant_id
    AND EXISTS (
      SELECT 1 FROM credenciales_biometricas c
      WHERE c.usuario_id = u.id
        AND c.tenant_id = v_lector.tenant_id
        AND c.revocada_at IS NULL
    );

  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'HUELLA_NO_RECONOCIDA: Esa huella no está registrada en este gimnasio';
  END IF;

  v_ventana := ventana_check_in_min(v_lector.tenant_id);

  -- W2-03: FOR UPDATE OF r serializa el check-in de la reserva elegida; el segundo
  -- ingreso concurrente bloquea y luego ya no la encuentra 'confirmada'.
  SELECT r.* INTO v_reserva
  FROM reservas r
  JOIN recursos rec ON rec.id = r.recurso_id
  WHERE r.tenant_id = v_lector.tenant_id
    AND r.usuario_id = v_socio.id
    AND r.status = 'confirmada'
    AND p_at >= r.slot_inicio - (v_ventana || ' minutes')::interval
    AND p_at <= r.slot_fin + (v_ventana * 2 || ' minutes')::interval
    AND (
      v_lector.sucursal_id IS NULL
      OR rec.sucursal_id = v_lector.sucursal_id
    )
  ORDER BY abs(extract(epoch FROM (r.slot_inicio - p_at)))
  LIMIT 1
  FOR UPDATE OF r;

  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'SIN_RESERVA: % no tiene ninguna reserva para este momento',
      COALESCE(v_socio.nombre, v_socio.email);
  END IF;

  PERFORM _guard_membresia_checkin(v_socio.id);

  UPDATE reservas
  SET status = 'completada',
      check_in_at = p_at,
      check_in_by = NULL,
      check_in_method = 'huella'
  WHERE id = v_reserva.id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = v_reserva.clase_id;

  PERFORM _audrec_log(
    'checkin.huella', 'reserva', v_reserva.id, v_socio.id, v_socio.nombre,
    format('Entró con huella por el lector "%s".', v_lector.nombre),
    jsonb_build_object('lector_id', v_lector.id, 'lector', v_lector.nombre)
  );

  RETURN jsonb_build_object(
    'success', true,
    'socio', jsonb_build_object(
      'id', v_socio.id,
      'nombre', v_socio.nombre,
      'avatar_url', v_socio.avatar_url
    ),
    'reserva_id', v_reserva.id,
    'clase', COALESCE(v_clase.nombre, v_recurso.nombre),
    'hora', to_char(v_reserva.slot_inicio, 'HH24:MI')
  );
END;
$$;

REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION check_in_por_huella(text, uuid, timestamptz) TO service_role;

-- 4) admin_marcar_asistencia
CREATE OR REPLACE FUNCTION admin_marcar_asistencia(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_miembro usuarios;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden corregir la asistencia';
  END IF;

  -- W2-03: FOR UPDATE (ver check_in_atomic).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;
  IF v_reserva.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro gimnasio';
  END IF;
  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este socio ya figura como presente';
  END IF;

  IF v_reserva.slot_inicio > now() THEN
    RAISE EXCEPTION 'CLASE_NO_INICIADA: Esa clase todavía no empieza; no se puede marcar asistencia';
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = now(),
      check_in_by = v_actor,
      check_in_method = 'manual',
      updated_at = now()
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;

  PERFORM _audrec_log(
    'clase.marcar_asistencia', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
    format('Corrigió la asistencia a "presente" en la clase de %s.%s',
           to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                THEN ' Motivo: ' || p_motivo ELSE '' END),
    jsonb_build_object('motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id);
END;
$$;

REVOKE ALL ON FUNCTION admin_marcar_asistencia(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_marcar_asistencia(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION admin_marcar_asistencia(uuid, text) TO authenticated;

-- 5) recepcion_corregir_checkin (revierte)
CREATE OR REPLACE FUNCTION recepcion_corregir_checkin(
  p_reserva_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_res RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para corregir un check-in';
  END IF;

  -- W2-03: FOR UPDATE OF r serializa la corrección contra un check-in concurrente.
  SELECT r.id, r.status, r.tenant_id, r.usuario_id, r.slot_inicio,
         r.check_in_at, r.check_in_by, r.check_in_method, u.nombre
  INTO v_res
  FROM reservas r
  LEFT JOIN usuarios u ON u.id = r.usuario_id
  WHERE r.id = p_reserva_id
  FOR UPDATE OF r;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;
  IF v_res.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa reserva no pertenece a tu negocio';
  END IF;
  IF v_res.status <> 'completada' THEN
    RAISE EXCEPTION 'CHECK_IN_NO_EXISTE: la reserva no tiene un check-in para corregir (status: %)', v_res.status;
  END IF;

  UPDATE reservas
  SET status = 'confirmada',
      check_in_at = NULL,
      check_in_by = NULL,
      check_in_method = NULL,
      updated_at = now()
  WHERE id = p_reserva_id;

  PERFORM _audrec_log(
    'checkin.corregir', 'reserva', p_reserva_id, v_res.usuario_id, v_res.nombre,
    format('Revirtió check-in de la reserva del %s. Motivo: %s',
           to_char(v_res.slot_inicio, 'DD/MM HH24:MI'), p_motivo),
    jsonb_build_object(
      'motivo', p_motivo,
      'check_in_anterior', jsonb_build_object(
        'check_in_at', v_res.check_in_at,
        'check_in_by', v_res.check_in_by,
        'check_in_method', v_res.check_in_method
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'status', 'confirmada');
END;
$$;

REVOKE ALL ON FUNCTION recepcion_corregir_checkin(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_corregir_checkin(uuid, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- W2-01 · reserva: serializa el cupo por CLASE en TODAS las salas.
--   reservar_clase_atomic: verbatim de 20260925140000, subiendo el advisory lock
--   fuera del ramo "con mapa" para que también cubra salas de conteo.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reservar_clase_atomic(
  p_clase_id uuid,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL,
  p_invitados_detalle jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_usuario usuarios;
  v_clase clases;
  v_recurso recursos;
  v_tenant tenants;
  v_now timestamptz := now();
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_min_anticipacion_min integer;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;
  v_existe_doble boolean;
  v_existe_continua boolean;
  v_permitir_continuas boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  v_es_socio boolean;
  v_mem_id uuid;
  v_mem_status text;
  v_mem_inicio timestamptz;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_es_pase boolean;
  v_nuevo_creditos integer;
  v_costo integer;
  v_tier_todas_sedes boolean;
  v_mem_sucursal uuid;

  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;

  v_con_detalle boolean := (p_invitados_detalle IS NOT NULL AND jsonb_array_length(p_invitados_detalle) > 0);
  v_lugares_guest text[];
  v_lugares_todos text[];
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = p_clase_id;
  SELECT * INTO v_tenant  FROM tenants  WHERE id = v_tenant_id;

  IF v_clase IS NULL OR v_clase.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;

  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);

  IF v_clase.status != 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible (status: %)', v_clase.status;
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso IS NULL THEN
    RAISE EXCEPTION 'RECURSO_NO_EXISTE: Sala no encontrada';
  END IF;
  IF NOT v_recurso.activo THEN
    RAISE EXCEPTION 'RECURSO_INACTIVO: Esta sala no está disponible';
  END IF;

  -- W2-01: serializa TODA la reserva de ESTA clase (cupo + asientos) para TODAS
  -- las salas — no solo las de mapa. Sin esto, en salas de conteo dos socios
  -- distintos podían leer el mismo SUM y sobrevender el último lugar. Se toma acá,
  -- antes del cálculo de cupo y antes del FOR UPDATE de la membresía (mismo orden
  -- que ya usaban las salas con mapa → sin deadlock).
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || p_clase_id::text));

  -- ── MAPA DE SALÓN ─────────────────────────────────────────────────────────
  IF v_recurso.layout IS NOT NULL THEN
    IF p_lugar_id IS NULL THEN
      RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para esta clase';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l WHERE l->>'id' = p_lugar_id
    ) THEN
      RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
    END IF;

    IF v_con_detalle THEN
      p_invitados := jsonb_array_length(p_invitados_detalle);

      IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_invitados_detalle) e WHERE NULLIF(trim(e->>'nombre'), '') IS NULL) THEN
        RAISE EXCEPTION 'INVITADO_SIN_NOMBRE: Cada invitado necesita un nombre';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_invitados_detalle) e WHERE NULLIF(trim(e->>'lugar_id'), '') IS NULL) THEN
        RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para cada invitado';
      END IF;

      SELECT array_agg(e->>'lugar_id') INTO v_lugares_guest FROM jsonb_array_elements(p_invitados_detalle) e;
      v_lugares_todos := array_append(v_lugares_guest, p_lugar_id);

      IF (SELECT count(*) FROM unnest(v_lugares_todos)) <> (SELECT count(DISTINCT x) FROM unnest(v_lugares_todos) x) THEN
        RAISE EXCEPTION 'LUGAR_DUPLICADO: No repitas el mismo lugar';
      END IF;
      IF EXISTS (
        SELECT 1 FROM unnest(v_lugares_guest) g
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') l WHERE l->>'id' = g)
      ) THEN
        RAISE EXCEPTION 'LUGAR_INVALIDO: Un lugar de invitado no existe en la sala';
      END IF;
      IF EXISTS (
        SELECT 1 FROM reservas
        WHERE clase_id = p_clase_id AND status IN ('confirmada','completada')
          AND lugar_id = ANY(v_lugares_todos)
      ) OR EXISTS (
        SELECT 1 FROM reserva_invitados WHERE clase_id = p_clase_id AND lugar_id = ANY(v_lugares_todos)
      ) THEN
        RAISE EXCEPTION 'LUGAR_OCUPADO: Uno de los lugares ya está tomado, elegí otro';
      END IF;
    ELSE
      IF p_invitados > 0 THEN
        RAISE EXCEPTION 'LUGAR_SIN_INVITADOS: Elegí un lugar para cada invitado';
      END IF;
      IF EXISTS (
        SELECT 1 FROM reservas
        WHERE clase_id = p_clase_id AND lugar_id = p_lugar_id AND status IN ('confirmada','completada')
      ) OR EXISTS (
        SELECT 1 FROM reserva_invitados WHERE clase_id = p_clase_id AND lugar_id = p_lugar_id
      ) THEN
        RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elegí otro';
      END IF;
    END IF;
  ELSE
    p_lugar_id := NULL; -- sala sin mapa: se ignora cualquier lugar (y p_invitados_detalle).
  END IF;

  v_es_socio := v_usuario.rol = 'miembro';

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_es_socio THEN
    SELECT m.id, m.status, m.periodo_actual_inicio, m.periodo_actual_fin,
           m.creditos_restantes, t.tipo,
           t.acceso_todas_sucursales, m.sucursal_id,
           COALESCE(t.invitados_por_periodo, 0),
           COALESCE(t.es_pase, false)
    INTO v_mem_id, v_mem_status, v_mem_inicio, v_mem_fin,
         v_mem_creditos, v_tier_tipo,
         v_tier_todas_sedes, v_mem_sucursal,
         v_inv_incluidos,
         v_es_pase
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_user_id
      AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
    ORDER BY
      CASE m.status
        WHEN 'activa'    THEN 0
        WHEN 'trialing'  THEN 1
        WHEN 'past_due'  THEN 2
        WHEN 'congelada' THEN 3
      END,
      m.created_at DESC
    LIMIT 1
    FOR UPDATE OF m;

    IF v_mem_id IS NULL THEN
      RAISE EXCEPTION 'SIN_MEMBRESIA: No tenés una membresía activa';
    END IF;

    IF v_mem_status = 'congelada' THEN
      RAISE EXCEPTION 'MEMBRESIA_CONGELADA: Tu membresía está pausada';
    END IF;

    IF v_mem_fin IS NOT NULL AND v_mem_fin <= v_now THEN
      RAISE EXCEPTION 'MEMBRESIA_VENCIDA: Tu membresía venció el %',
        to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
    END IF;
  END IF;

  IF v_es_socio THEN
    IF NOT _sala_permite_tier(v_recurso.tiers_permitidos, v_usuario.membresia_tier) THEN
      RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
    END IF;
  END IF;

  IF v_es_socio AND NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: Tu plan solo cubre tu sede';
  END IF;

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;

  IF v_es_socio AND p_invitados > 0 THEN
    IF COALESCE(v_inv_incluidos, 0) = 0 THEN
      RAISE EXCEPTION 'INVITADOS_NO_INCLUIDOS: Tu plan no incluye pases de invitado';
    END IF;

    v_ventana_inicio := COALESCE(v_mem_inicio, date_trunc('month', v_now));
    v_ventana_fin    := COALESCE(v_mem_fin, v_ventana_inicio + interval '1 month');

    SELECT COALESCE(SUM(r.invitados_count), 0)
    INTO v_inv_usados
    FROM reservas r
    WHERE r.usuario_id = v_user_id
      AND r.status IN ('confirmada', 'completada', 'no_show')
      AND r.created_at >= v_ventana_inicio
      AND r.created_at <  v_ventana_fin;

    v_inv_disponibles := GREATEST(v_inv_incluidos - COALESCE(v_inv_usados, 0), 0);

    IF p_invitados > v_inv_disponibles THEN
      RAISE EXCEPTION
        'INVITADOS_EXCEDEN: Tu plan incluye % pase(s) de invitado por periodo y te quedan %',
        v_inv_incluidos, v_inv_disponibles;
    END IF;
  END IF;

  v_costo := 1 + p_invitados;
  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido')
     AND COALESCE(v_mem_creditos, 0) < v_costo THEN
    RAISE EXCEPTION 'SIN_CREDITOS: Necesitás % crédito(s) (vos + % invitado(s)) y te quedan %',
      v_costo, p_invitados, COALESCE(v_mem_creditos, 0);
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  IF v_es_socio AND NOT COALESCE(v_es_pase, false) AND v_mem_fin IS NOT NULL
     AND (v_slot_inicio AT TIME ZONE v_tz)::date > (v_mem_fin AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'CLASE_FUERA_DE_VIGENCIA: Esa clase es posterior al vencimiento de tu plan (%). Renueva para reservarla.',
      to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
  END IF;

  v_min_anticipacion_min := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_minutos')::integer,
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer * 60,
    (v_tenant.config->>'min_anticipacion_horas')::integer * 60,
    0);
  IF v_slot_inicio < v_now + (v_min_anticipacion_min || ' minutes')::interval THEN
    RAISE EXCEPTION 'ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % minutos de anticipación', v_min_anticipacion_min;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE clase_id = p_clase_id
      AND usuario_id = v_user_id
      AND status IN ('confirmada','completada')
  ) INTO v_existe_doble;
  IF v_existe_doble THEN
    RAISE EXCEPTION 'YA_RESERVADO: Ya tenés una reserva activa en esta clase';
  END IF;

  v_permitir_continuas := COALESCE((v_tenant.config->'reserva'->>'permitir_continuas')::boolean, false);
  IF NOT v_permitir_continuas THEN
    SELECT EXISTS(
      SELECT 1 FROM reservas
      WHERE usuario_id = v_user_id
        AND status IN ('confirmada','completada')
        AND (slot_fin = v_slot_inicio OR slot_inicio = v_slot_fin)
    ) INTO v_existe_continua;
    IF v_existe_continua THEN
      RAISE EXCEPTION 'CONTINUA: No puedes reservar horas continuas';
    END IF;
  END IF;

  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada','completada');

  v_cupo_efectivo := CASE
    WHEN v_recurso.layout IS NOT NULL
      THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
    ELSE v_clase.cupo_max
  END;

  IF v_cupos_ocupados + 1 + p_invitados > v_cupo_efectivo THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_cupo_efectivo;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas,
    clase_id, lugar_id
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, v_user_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas,
    p_clase_id, p_lugar_id
  )
  RETURNING id INTO v_reserva_id;

  IF v_recurso.layout IS NOT NULL AND v_con_detalle THEN
    INSERT INTO reserva_invitados (tenant_id, reserva_id, clase_id, nombre, telefono, email, lugar_id)
    SELECT v_tenant_id, v_reserva_id, p_clase_id,
           NULLIF(trim(e->>'nombre'), ''), NULLIF(trim(e->>'telefono'), ''),
           NULLIF(trim(e->>'email'), ''), e->>'lugar_id'
    FROM jsonb_array_elements(p_invitados_detalle) e;
  END IF;

  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - v_costo
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -v_costo,
      v_reserva_id,
      'reserva ' || v_folio_nuevo
        || CASE WHEN p_invitados > 0 THEN ' (+' || p_invitados || ' invitado(s))' ELSE '' END,
      v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', p_clase_id,
    'lugar_id', p_lugar_id,
    'creditos_restantes', v_nuevo_creditos,
    'invitados_restantes', CASE
      WHEN v_es_socio AND COALESCE(v_inv_incluidos, 0) > 0
        THEN GREATEST(COALESCE(v_inv_disponibles, v_inv_incluidos) - p_invitados, 0)
      ELSE 0
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION reservar_clase_atomic(uuid, integer, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservar_clase_atomic(uuid, integer, text, text, jsonb) TO authenticated;

-- recepcion_crear_reserva: verbatim de 20260715130000 + el advisory lock por clase.
CREATE OR REPLACE FUNCTION recepcion_crear_reserva(
  p_usuario_id uuid,
  p_clase_id uuid DEFAULT NULL,
  p_horario_id uuid DEFAULT NULL,
  p_fecha date DEFAULT NULL,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_tenant_id uuid;
  v_socio usuarios;
  v_clase clases;
  v_clase_id uuid;
  v_recurso recursos;
  v_now timestamptz := now();
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  v_mem_id uuid;
  v_mem_status text;
  v_mem_inicio timestamptz;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_tier_todas_sedes boolean;
  v_mem_sucursal uuid;
  v_nuevo_creditos integer;
  v_costo integer;

  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
BEGIN
  v_actor_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_actor_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden reservar por un socio';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;
  IF v_socio.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El socio es de otro gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Solo se reserva para socios';
  END IF;

  v_clase_id := p_clase_id;
  IF v_clase_id IS NULL THEN
    IF p_horario_id IS NULL OR p_fecha IS NULL THEN
      RAISE EXCEPTION 'CLASE_REQUERIDA: Falta la clase (o el horario + fecha)';
    END IF;
    v_clase_id := materializar_clase(p_horario_id, p_fecha);
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_clase_id;
  IF v_clase IS NULL OR v_clase.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;
  IF v_clase.status <> 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible (status: %)', v_clase.status;
  END IF;

  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso IS NULL OR NOT v_recurso.activo THEN
    RAISE EXCEPTION 'RECURSO_INACTIVO: Esta sala no está disponible';
  END IF;

  -- W2-01: serializa el cupo/asientos de ESTA clase (todas las salas), antes del
  -- check de lugar/cupo y antes del FOR UPDATE de la membresía. Mismo lock y orden
  -- que reservar_clase_atomic → sin deadlock. (Antes esta función no tenía lock.)
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || v_clase_id::text));

  IF v_recurso.layout IS NOT NULL THEN
    IF p_invitados > 0 THEN
      RAISE EXCEPTION 'LUGAR_SIN_INVITADOS: En salas con lugar asignado, cada persona reserva su propio lugar';
    END IF;
    IF p_lugar_id IS NULL THEN
      RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para esta clase';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l
      WHERE l->>'id' = p_lugar_id
    ) THEN
      RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
    END IF;
    IF EXISTS (
      SELECT 1 FROM reservas
      WHERE clase_id = v_clase_id AND lugar_id = p_lugar_id
        AND status IN ('confirmada','completada')
    ) THEN
      RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elegí otro';
    END IF;
  ELSE
    p_lugar_id := NULL;
  END IF;

  IF v_socio.bloqueado_hasta IS NOT NULL AND v_socio.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: El socio tiene una restricción hasta el %',
      to_char(v_socio.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  SELECT m.id, m.status, m.periodo_actual_inicio, m.periodo_actual_fin,
         m.creditos_restantes, t.tipo, t.acceso_todas_sucursales, m.sucursal_id,
         COALESCE(t.invitados_por_periodo, 0)
  INTO v_mem_id, v_mem_status, v_mem_inicio, v_mem_fin,
       v_mem_creditos, v_tier_tipo, v_tier_todas_sedes, v_mem_sucursal,
       v_inv_incluidos
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY
    CASE m.status
      WHEN 'activa'    THEN 0
      WHEN 'trialing'  THEN 1
      WHEN 'past_due'  THEN 2
      WHEN 'congelada' THEN 3
    END,
    m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem_id IS NULL THEN
    RAISE EXCEPTION 'SIN_MEMBRESIA: El socio no tiene una membresía activa';
  END IF;
  IF v_mem_status = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_CONGELADA: La membresía del socio está pausada';
  END IF;
  IF v_mem_fin IS NOT NULL AND v_mem_fin <= v_now THEN
    RAISE EXCEPTION 'MEMBRESIA_VENCIDA: La membresía venció el %',
      to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
  END IF;

  IF NOT _sala_permite_tier(v_recurso.tiers_permitidos, v_socio.membresia_tier) THEN
    RAISE EXCEPTION 'TIER_NO_PERMITIDO: El plan del socio no da acceso a esta sala';
  END IF;

  IF NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: El plan del socio solo cubre su sede';
  END IF;

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;

  IF p_invitados > 0 THEN
    IF COALESCE(v_inv_incluidos, 0) = 0 THEN
      RAISE EXCEPTION 'INVITADOS_NO_INCLUIDOS: El plan del socio no incluye pases de invitado';
    END IF;

    v_ventana_inicio := COALESCE(v_mem_inicio, date_trunc('month', v_now));
    v_ventana_fin    := COALESCE(v_mem_fin, v_ventana_inicio + interval '1 month');

    SELECT COALESCE(SUM(r.invitados_count), 0)
    INTO v_inv_usados
    FROM reservas r
    WHERE r.usuario_id = p_usuario_id
      AND r.status IN ('confirmada', 'completada', 'no_show')
      AND r.created_at >= v_ventana_inicio
      AND r.created_at <  v_ventana_fin;

    v_inv_disponibles := GREATEST(v_inv_incluidos - COALESCE(v_inv_usados, 0), 0);

    IF p_invitados > v_inv_disponibles THEN
      RAISE EXCEPTION
        'INVITADOS_EXCEDEN: El plan incluye % pase(s) por periodo y le quedan %',
        v_inv_incluidos, v_inv_disponibles;
    END IF;
  END IF;

  v_costo := 1 + p_invitados;
  IF v_tier_tipo IN ('creditos', 'hibrido')
     AND COALESCE(v_mem_creditos, 0) < v_costo THEN
    RAISE EXCEPTION 'SIN_CREDITOS: Necesita % clase(s) y le quedan %',
      v_costo, COALESCE(v_mem_creditos, 0);
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = v_clase_id
      AND usuario_id = p_usuario_id
      AND status IN ('confirmada','completada')
  ) THEN
    RAISE EXCEPTION 'YA_RESERVADO: El socio ya tiene una reserva en esta clase';
  END IF;

  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = v_clase_id
    AND status IN ('confirmada','completada');

  v_cupo_efectivo := CASE
    WHEN v_recurso.layout IS NOT NULL
      THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
    ELSE v_clase.cupo_max
  END;

  IF v_cupos_ocupados + 1 + p_invitados > v_cupo_efectivo THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_cupo_efectivo;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas,
    clase_id, lugar_id
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, p_usuario_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo,
    COALESCE(NULLIF(trim(p_notas), ''), 'Walk-in en mostrador'),
    v_clase_id, p_lugar_id
  )
  RETURNING id INTO v_reserva_id;

  IF v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - v_costo
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -v_costo,
      v_reserva_id,
      'reserva ' || v_folio_nuevo || ' (mostrador)'
        || CASE WHEN p_invitados > 0 THEN ' (+' || p_invitados || ' invitado(s))' ELSE '' END,
      v_actor_id
    );
  END IF;

  PERFORM _audrec_log(
    'reserva.crear',
    'reserva',
    v_reserva_id,
    p_usuario_id,
    v_socio.nombre,
    format('Creó una reserva en el mostrador (%s). Motivo: %s',
           v_clase.nombre, COALESCE(NULLIF(trim(p_motivo), ''), 'walk-in')),
    jsonb_build_object(
      'clase_id', v_clase_id,
      'folio', v_folio_nuevo,
      'invitados', p_invitados,
      'motivo', p_motivo
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', v_clase_id,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

GRANT EXECUTE ON FUNCTION recepcion_crear_reserva(uuid, uuid, uuid, date, integer, text, text, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST DE CONTRATO — ninguna recreación pudo perder un guard ni el lock.
-- (misma idea que 20260715130000 / 20260717100000: falla la migración acá, no en
--  producción semanas después)
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_src text; v_codigo text; v_faltan text[] := ARRAY[]::text[];
  c_reservar text[] := ARRAY[
    'NO_AUTH','CLASE_NO_EXISTE','CLASE_NO_PROGRAMADA','RECURSO_NO_EXISTE','RECURSO_INACTIVO',
    'LUGAR_REQUERIDO','LUGAR_INVALIDO','LUGAR_OCUPADO','LUGAR_DUPLICADO','LUGAR_SIN_INVITADOS',
    'INVITADO_SIN_NOMBRE','USUARIO_INACTIVO','USUARIO_BLOQUEADO','SIN_MEMBRESIA','MEMBRESIA_CONGELADA',
    'MEMBRESIA_VENCIDA','TIER_NO_PERMITIDO','SUCURSAL_NO_INCLUIDA','INVITADOS_INVALIDOS',
    'INVITADOS_NO_INCLUIDOS','INVITADOS_EXCEDEN','SIN_CREDITOS','CLASE_FUERA_DE_VIGENCIA',
    'ANTICIPACION_INSUFICIENTE','YA_RESERVADO','CONTINUA','CUPO_LLENO'
  ];
  c_recepcion text[] := ARRAY[
    'NO_AUTH','NO_AUTORIZADO','USUARIO_NO_EXISTE','ROL_INVALIDO','CLASE_REQUERIDA','CLASE_NO_EXISTE',
    'CLASE_NO_PROGRAMADA','RECURSO_INACTIVO','LUGAR_SIN_INVITADOS','LUGAR_REQUERIDO','LUGAR_INVALIDO',
    'LUGAR_OCUPADO','USUARIO_BLOQUEADO','SIN_MEMBRESIA','MEMBRESIA_CONGELADA','MEMBRESIA_VENCIDA',
    'TIER_NO_PERMITIDO','SUCURSAL_NO_INCLUIDA','INVITADOS_INVALIDOS','INVITADOS_NO_INCLUIDOS',
    'SIN_CREDITOS','YA_RESERVADO','CUPO_LLENO'
  ];
  c_checkin text[] := ARRAY[
    'NO_AUTH','NO_AUTORIZADO','RESERVA_NO_EXISTE','TENANT_DIFERENTE','YA_CHECK_IN',
    'RESERVA_CANCELADA','RESERVA_NO_SHOW','DEMASIADO_TEMPRANO','DEMASIADO_TARDE'
  ];
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'reservar_clase_atomic';
  FOREACH v_codigo IN ARRAY c_reservar LOOP
    IF position(v_codigo IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'reservar:'||v_codigo); END IF;
  END LOOP;
  IF position('pg_advisory_xact_lock' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'reservar:LOCK'); END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'recepcion_crear_reserva';
  FOREACH v_codigo IN ARRAY c_recepcion LOOP
    IF position(v_codigo IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'recepcion:'||v_codigo); END IF;
  END LOOP;
  IF position('pg_advisory_xact_lock' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'recepcion:LOCK'); END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'check_in_atomic';
  FOREACH v_codigo IN ARRAY c_checkin LOOP
    IF position(v_codigo IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'checkin_qr:'||v_codigo); END IF;
  END LOOP;
  IF position('FOR UPDATE' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'checkin_qr:FOR_UPDATE'); END IF;
  IF position('_guard_membresia_checkin' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'checkin_qr:guard_membresia'); END IF;
  IF position('_guard_sucursal_staff' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'checkin_qr:guard_sucursal'); END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'check_in_manual_atomic';
  IF position('FOR UPDATE' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'checkin_manual:FOR_UPDATE'); END IF;
  IF position('_guard_membresia_checkin' IN v_src) > 0 THEN v_faltan := array_append(v_faltan, 'checkin_manual:NO_debe_bloquear_membresia'); END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'check_in_por_huella';
  IF position('FOR UPDATE OF r' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'checkin_huella:FOR_UPDATE'); END IF;
  IF position('_guard_membresia_checkin' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'checkin_huella:guard_membresia'); END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'admin_marcar_asistencia';
  IF position('FOR UPDATE' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'admin_asistencia:FOR_UPDATE'); END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'recepcion_corregir_checkin';
  IF position('FOR UPDATE OF r' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'corregir:FOR_UPDATE'); END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'hacer_corte_caja';
  IF position('pg_advisory_xact_lock' IN v_src) = 0 THEN v_faltan := array_append(v_faltan, 'corte:LOCK'); END IF;

  IF cardinality(v_faltan) > 0 THEN
    RAISE EXCEPTION 'W2_CONTRATO_ROTO: %', array_to_string(v_faltan, ', ');
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST FUNCIONAL (secuencial) — DEVUELVE TABLA.
--   1) sala de conteo: se llena y la siguiente reserva → CUPO_LLENO (regresión).
--   2) doble check-in secuencial → YA_CHECK_IN (regresión bajo el nuevo FOR UPDATE).
--   3) corte de caja crea normalmente bajo el lock.
--   La verdadera prueba PARALELA (dos conexiones) queda BLOCKED: no hay DB
--   no-productiva; se valida por construcción + estructura (contrato de arriba).
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_wave2()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_admin uuid;
  v_suc uuid; v_sala uuid; v_tier uuid; v_clase uuid;
  v_s1 uuid; v_s2 uuid; v_r1 uuid; v_r2 uuid;
  v_slug text := 'zz-w2-' || substr(md5(random()::text), 1, 6);
  v_now timestamptz := now(); v_ok boolean; v_err text; v_res jsonb;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'W2','gym_libre','activo') RETURNING id INTO v_tenant;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',v_slug||'-a@sala.dev',
          jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),'',now(),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth RETURNING id INTO v_admin;
  INSERT INTO sucursales (tenant_id,nombre,timezone,activa,orden) VALUES (v_tenant,'Sede','America/Mexico_City',true,0) RETURNING id INTO v_suc;
  -- Sala de CONTEO (sin layout), cupo 1.
  INSERT INTO recursos (tenant_id,sucursal_id,slug,nombre,tipo,cupos,cupo_max_default,activo)
  VALUES (v_tenant,v_suc,'sala-1','Sala 1','sala_grupal',1,1,true) RETURNING id INTO v_sala;
  INSERT INTO tiers (tenant_id,slug,nombre,tipo,precio_centavos,moneda,activo,orden)
  VALUES (v_tenant,'mensual','Mensual','tiempo',100000,'MXN',true,0) RETURNING id INTO v_tier;
  -- Clase HOY, cupo 1.
  INSERT INTO clases (tenant_id,sucursal_id,recurso_id,fecha,hora_inicio,duracion_minutos,cupo_max,status,nombre)
  VALUES (v_tenant,v_suc,v_sala,(v_now AT TIME ZONE 'America/Mexico_City')::date,
          (v_now AT TIME ZONE 'America/Mexico_City')::time,60,1,'programada','Clase W2') RETURNING id INTO v_clase;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-s1@x.dev','S1','miembro','activo') RETURNING id INTO v_s1;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-s2@x.dev','S2','miembro','activo') RETURNING id INTO v_s2;
  INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin)
  VALUES (v_tenant,v_s1,v_tier,'activa',v_now-interval '1 day',v_now+interval '30 days'),
         (v_tenant,v_s2,v_tier,'activa',v_now-interval '1 day',v_now+interval '30 days');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- 1) Recepción reserva al s1 (llena el cupo=1); s2 → CUPO_LLENO.
  v_res := recepcion_crear_reserva(v_s1, v_clase, NULL, NULL, 0, 'test', NULL, 'w2');
  v_ok := false;
  BEGIN
    PERFORM recepcion_crear_reserva(v_s2, v_clase, NULL, NULL, 0, 'test', NULL, 'w2');
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'CUPO_LLENO%';
  END;
  prueba := '1. sala de conteo llena → CUPO_LLENO (recepcion_crear_reserva con lock)';
  resultado := CASE WHEN v_ok THEN '✅ rechazó la sobreventa' ELSE '❌ no frenó' END; RETURN NEXT;

  -- 2) Doble check-in secuencial de la reserva de s1 → YA_CHECK_IN.
  v_r1 := (v_res->>'reserva_id')::uuid;
  PERFORM check_in_manual_atomic(v_r1, 'primero');
  v_ok := false;
  BEGIN
    PERFORM check_in_manual_atomic(v_r1, 'segundo');
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'YA_CHECK_IN%';
  END;
  prueba := '2. segundo check-in → YA_CHECK_IN (bajo FOR UPDATE)';
  resultado := CASE WHEN v_ok THEN '✅ una sola asistencia' ELSE '❌ dejó doble' END; RETURN NEXT;

  -- 3) Corte de caja crea normalmente bajo el lock.
  v_res := hacer_corte_caja(v_now - interval '1 hour', v_now + interval '1 hour', NULL, 0, 0, 'w2');
  prueba := '3. corte de caja crea bajo advisory lock';
  resultado := CASE WHEN (v_res->>'success')::boolean THEN '✅ corte creado' ELSE '❌ falló' END; RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
  RETURN;
END $$;

SELECT * FROM _diag_wave2();
DROP FUNCTION _diag_wave2();

COMMIT;
