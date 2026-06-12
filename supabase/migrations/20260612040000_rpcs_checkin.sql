-- ============================================================================
-- Check-in: corregir + bitácora automática  (Sub-round 2 · Fase 2 · Migración 4)
-- ----------------------------------------------------------------------------
-- A) Extiende el enum de auditoria_recepcion.accion con 'checkin.corregir'.
-- B) Crea recepcion_corregir_checkin (revierte un check-in).
-- C) Recrea check_in_atomic / check_in_manual_atomic IDÉNTICOS (misma firma,
--    return y lógica) + una llamada a _audrec_log al final del path exitoso.
--    El log va GUARDADO por rol: ambos RPCs aceptan rol 'staff', pero
--    _audrec_log (y el CHECK actor_rol de la tabla) solo admiten
--    recepcionista/admin. Sin la guardia, un check-in de un 'staff' rompería.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PARTE A — enum de accion: agregar 'checkin.corregir'.
-- El CHECK es inline (sin nombre explícito en 20260611) → Postgres lo nombra
-- auditoria_recepcion_accion_check. Lo buscamos por INTROSPECCIÓN (la constraint
-- cuyo conkey es exactamente la columna accion) para dropearlo por su nombre
-- real, robusto contra cualquier nombre, y lo recreamos con la lista completa.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_attnum smallint;
  v_name text;
BEGIN
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'auditoria_recepcion'::regclass
    AND attname = 'accion'
    AND NOT attisdropped;

  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'auditoria_recepcion'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[v_attnum]::int2[]
  LIMIT 1;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE auditoria_recepcion DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

ALTER TABLE auditoria_recepcion ADD CONSTRAINT auditoria_recepcion_accion_check
  CHECK (accion IN (
    'membresia.renovar','membresia.cambiar_plan','membresia.recargar_creditos',
    'membresia.congelar','membresia.reactivar','membresia.cancelar',
    'reserva.crear','reserva.cancelar','reserva.lista_espera_anotar','reserva.lista_espera_promover',
    'socio.crear','socio.editar_contacto','socio.reset_password','socio.bloquear','socio.desbloquear','socio.nota',
    'clase.crear','clase.cancelar','clase.reasignar_coach','clase.marcar_asistencia','clase.marcar_no_show',
    'pago.reenviar_link','pago.activar',
    'checkin.manual','checkin.qr','checkin.corregir'
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- PARTE B — recepcion_corregir_checkin: revierte un check-in completado.
-- ─────────────────────────────────────────────────────────────────────────────
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

  SELECT r.id, r.status, r.tenant_id, r.usuario_id, r.slot_inicio,
         r.check_in_at, r.check_in_by, r.check_in_method, u.nombre
  INTO v_res
  FROM reservas r
  LEFT JOIN usuarios u ON u.id = r.usuario_id
  WHERE r.id = p_reserva_id;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- PARTE C.1 — check_in_atomic: IDÉNTICO a 20260514150000 + _audrec_log guardado.
-- ─────────────────────────────────────────────────────────────────────────────
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

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  v_ventana_inicio := v_reserva.slot_inicio - interval '15 minutes';
  v_ventana_fin := v_reserva.slot_fin + interval '30 minutes';

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in abre 15 min antes (a las %)',
      to_char(v_ventana_inicio, 'HH24:MI');
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

  -- Contadores
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

  -- Bitácora (solo recep/admin; un 'staff' no se puede registrar como actor).
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

GRANT EXECUTE ON FUNCTION check_in_atomic(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- PARTE C.2 — check_in_manual_atomic: IDÉNTICO + _audrec_log guardado.
-- ─────────────────────────────────────────────────────────────────────────────
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

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in';
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Reserva cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Reserva marcada como inasistencia';
  END IF;

  v_ventana_inicio := v_reserva.slot_inicio - interval '30 minutes';
  v_ventana_fin := v_reserva.slot_fin + interval '60 minutes';

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in manual abre 30 min antes (a las %)',
      to_char(v_ventana_inicio, 'HH24:MI');
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

  -- Bitácora (solo recep/admin; un 'staff' no se puede registrar como actor).
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

GRANT EXECUTE ON FUNCTION check_in_manual_atomic(uuid, text) TO authenticated;

-- ============================================================================
-- TEST integrado — solo recepcion_corregir_checkin. Savepoint + centinela
-- 'ROLLBACK_TEST_4' revierte todo. Mismo patrón que migraciones 1-3.
-- ============================================================================
DO $$
DECLARE
  v_recep        uuid;
  v_recep_auth   uuid;
  v_recep_tenant uuid;
  v_reserva_id   uuid;
  v_status       text;
  v_checkin      timestamptz;
  v_pre  int;
  v_post int;
BEGIN
  SELECT id, auth_id, tenant_id
  INTO v_recep, v_recep_auth, v_recep_tenant
  FROM usuarios
  WHERE rol = 'recepcionista' AND auth_id IS NOT NULL
  LIMIT 1;

  IF v_recep IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay recepcionista con auth_id (la migración aplicó enum + 3 funciones).';
    RETURN;
  END IF;

  -- Reserva completada del mismo tenant (si no hay, SKIP).
  SELECT id INTO v_reserva_id
  FROM reservas
  WHERE tenant_id = v_recep_tenant AND status = 'completada'
  ORDER BY check_in_at DESC NULLS LAST
  LIMIT 1;

  IF v_reserva_id IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay reserva completada en el tenant del recepcionista (la migración aplicó enum + 3 funciones).';
    RETURN;
  END IF;

  SELECT count(*) INTO v_pre FROM auditoria_recepcion;

  BEGIN  -- ── subtransacción reversible ──────────────────────────────────────
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_recep_auth::text)::text,
      true
    );

    PERFORM recepcion_corregir_checkin(v_reserva_id, 'Test: corrección integrada');

    SELECT status, check_in_at INTO v_status, v_checkin FROM reservas WHERE id = v_reserva_id;
    IF v_status <> 'confirmada' OR v_checkin IS NOT NULL THEN
      RAISE EXCEPTION 'TEST FAIL: la reserva no volvió a confirmada/sin check-in (status=%, check_in_at=%).', v_status, v_checkin;
    END IF;

    SELECT count(*) INTO v_post FROM auditoria_recepcion;
    IF v_post <> v_pre + 1 THEN
      RAISE EXCEPTION 'TEST FAIL: no se insertó la fila de bitácora (pre=% post=%).', v_pre, v_post;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM auditoria_recepcion
      WHERE accion = 'checkin.corregir' AND entidad_id = v_reserva_id
    ) THEN
      RAISE EXCEPTION 'TEST FAIL: la fila no tiene accion=checkin.corregir / reserva esperada.';
    END IF;

    RAISE EXCEPTION 'ROLLBACK_TEST_4';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_TEST_4' THEN
      NULL;  -- ok: subtransacción revertida
    ELSE
      RAISE;
    END IF;
  END;

  SELECT count(*) INTO v_post FROM auditoria_recepcion;
  IF v_post <> v_pre THEN
    RAISE EXCEPTION 'TEST FAIL: la fila de prueba no se revirtió (pre=% post=%).', v_pre, v_post;
  END IF;

  RAISE NOTICE 'TEST OK ✔ recepcion_corregir_checkin revirtió el check-in + escribió bitácora (checkin.corregir) y se revirtió.';
END $$;
