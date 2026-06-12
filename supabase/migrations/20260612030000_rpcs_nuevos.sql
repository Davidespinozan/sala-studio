-- ============================================================================
-- RPCs nuevos de recepción  (Sub-round 2 · Fase 2 · Migración 3)
-- ----------------------------------------------------------------------------
-- 7 acciones que no tenían equivalente en SALA. Cada RPC: gate staff →
-- scoping por tenant (los RPCs son SECURITY DEFINER y bypassean RLS, así que el
-- tenant del recurso DEBE validarse a mano) → aplica el cambio → escribe
-- bitácora vía _audrec_log.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 1: recepcion_recargar_creditos
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_recargar_creditos(
  p_usuario_id uuid,
  p_cantidad integer,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
  v_saldo_anterior integer;
  v_saldo_nuevo integer;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para recargar créditos';
  END IF;
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA: la cantidad debe ser mayor a 0';
  END IF;

  SELECT m.id, m.status, m.tenant_id, m.creditos_restantes, t.tipo, u.nombre
  INTO v_mem
  FROM membresias m
  JOIN tiers t   ON t.id = m.tier_id
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF v_mem.tipo = 'tiempo' THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_RECARGABLE: el plan es por tiempo, no usa créditos';
  END IF;
  IF v_mem.status NOT IN ('activa', 'congelada') THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_RECARGABLE: la membresía no está activa ni pausada';
  END IF;

  v_saldo_anterior := COALESCE(v_mem.creditos_restantes, 0);

  UPDATE membresias
  SET creditos_restantes = COALESCE(creditos_restantes, 0) + p_cantidad,
      updated_at = now()
  WHERE id = v_mem.id
  RETURNING creditos_restantes INTO v_saldo_nuevo;

  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo, created_by)
  VALUES (v_mem.id, v_tenant, 'ajuste', p_cantidad, p_motivo, get_my_user_id());

  PERFORM _audrec_log(
    'membresia.recargar_creditos', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Recargó %s créditos. Motivo: %s', p_cantidad, p_motivo),
    jsonb_build_object('cantidad', p_cantidad, 'motivo', p_motivo,
                       'saldo_anterior', v_saldo_anterior, 'saldo_nuevo', v_saldo_nuevo)
  );

  RETURN jsonb_build_object('success', true, 'saldo_nuevo', v_saldo_nuevo);
END;
$$;

REVOKE ALL ON FUNCTION recepcion_recargar_creditos(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_recargar_creditos(uuid, integer, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 2: recepcion_congelar_membresia
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_congelar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para congelar';
  END IF;

  SELECT m.id, m.status, m.tenant_id, u.nombre
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF v_mem.status = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_PAUSADA: la membresía ya estaba pausada';
  END IF;
  IF v_mem.status <> 'activa' THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_CONGELABLE: solo una membresía activa se puede pausar';
  END IF;

  UPDATE membresias SET status = 'congelada', updated_at = now() WHERE id = v_mem.id;

  PERFORM _audrec_log(
    'membresia.congelar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Pausó la membresía. Motivo: %s', p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', 'activa')
  );

  RETURN jsonb_build_object('success', true, 'status', 'congelada');
END;
$$;

REVOKE ALL ON FUNCTION recepcion_congelar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_congelar_membresia(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 3: recepcion_reactivar_membresia
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_reactivar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para reactivar';
  END IF;

  SELECT m.id, m.status, m.tenant_id, u.nombre
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF v_mem.status <> 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_ACTIVA: la membresía no estaba pausada';
  END IF;

  UPDATE membresias SET status = 'activa', updated_at = now() WHERE id = v_mem.id;

  PERFORM _audrec_log(
    'membresia.reactivar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Reactivó la membresía. Motivo: %s', p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', 'congelada')
  );

  RETURN jsonb_build_object('success', true, 'status', 'activa');
END;
$$;

REVOKE ALL ON FUNCTION recepcion_reactivar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_reactivar_membresia(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 4: recepcion_cancelar_membresia
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_cancelar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cancelar la membresía';
  END IF;

  SELECT m.id, m.status, m.tenant_id, u.nombre
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF v_mem.status = 'cancelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_CANCELADA: la membresía ya estaba cancelada';
  END IF;

  UPDATE membresias
  SET status = 'cancelada', cancelada_at = now(), updated_at = now()
  WHERE id = v_mem.id;

  PERFORM _audrec_log(
    'membresia.cancelar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Canceló la membresía. Motivo: %s', p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', v_mem.status)
  );

  RETURN jsonb_build_object('success', true, 'status', 'cancelada');
END;
$$;

REVOKE ALL ON FUNCTION recepcion_cancelar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_cancelar_membresia(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 5: recepcion_marcar_no_show
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_marcar_no_show(
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

  -- Motivo OPCIONAL
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    p_motivo := 'Marcado como no-show por recepción';
  END IF;

  SELECT r.id, r.status, r.tenant_id, r.usuario_id, r.slot_inicio, r.recurso_id, u.nombre
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
  IF v_res.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_MARCABLE: solo una reserva confirmada se puede marcar como no-show (status actual: %)', v_res.status;
  END IF;

  UPDATE reservas SET status = 'no_show', updated_at = now() WHERE id = p_reserva_id;
  UPDATE usuarios SET no_shows_count = no_shows_count + 1 WHERE id = v_res.usuario_id;

  PERFORM _audrec_log(
    'clase.marcar_no_show', 'reserva', p_reserva_id, v_res.usuario_id, v_res.nombre,
    format('Marcó no-show de la reserva del %s. Motivo: %s',
           to_char(v_res.slot_inicio, 'DD/MM HH24:MI'), p_motivo),
    jsonb_build_object('slot_inicio', v_res.slot_inicio, 'recurso_id', v_res.recurso_id, 'motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'status', 'no_show');
END;
$$;

REVOKE ALL ON FUNCTION recepcion_marcar_no_show(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_marcar_no_show(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 6: recepcion_bloquear_socio
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_bloquear_socio(
  p_usuario_id uuid,
  p_hasta timestamptz,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_socio RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para bloquear';
  END IF;
  IF p_hasta IS NULL OR p_hasta <= now() THEN
    RAISE EXCEPTION 'FECHA_INVALIDA: la fecha de fin del bloqueo debe ser futura';
  END IF;

  SELECT u.id, u.tenant_id, u.bloqueado_hasta, u.nombre
  INTO v_socio
  FROM usuarios u
  WHERE u.id = p_usuario_id;

  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: no encontramos ese socio';
  END IF;
  IF v_socio.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF v_socio.bloqueado_hasta IS NOT NULL AND v_socio.bloqueado_hasta > now() THEN
    RAISE EXCEPTION 'SOCIO_YA_BLOQUEADO: el socio ya estaba bloqueado';
  END IF;

  UPDATE usuarios SET bloqueado_hasta = p_hasta WHERE id = p_usuario_id;

  PERFORM _audrec_log(
    'socio.bloquear', 'socio', p_usuario_id, p_usuario_id, v_socio.nombre,
    format('Bloqueado hasta el %s. Motivo: %s', to_char(p_hasta, 'DD/MM'), p_motivo),
    jsonb_build_object('bloqueado_hasta', p_hasta, 'motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'bloqueado_hasta', p_hasta);
END;
$$;

REVOKE ALL ON FUNCTION recepcion_bloquear_socio(uuid, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_bloquear_socio(uuid, timestamptz, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 7: recepcion_desbloquear_socio
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_desbloquear_socio(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_socio RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para desbloquear';
  END IF;

  SELECT u.id, u.tenant_id, u.bloqueado_hasta, u.nombre
  INTO v_socio
  FROM usuarios u
  WHERE u.id = p_usuario_id;

  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: no encontramos ese socio';
  END IF;
  IF v_socio.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF v_socio.bloqueado_hasta IS NULL OR v_socio.bloqueado_hasta <= now() THEN
    RAISE EXCEPTION 'SOCIO_NO_BLOQUEADO: el socio no estaba bloqueado';
  END IF;

  UPDATE usuarios SET bloqueado_hasta = NULL WHERE id = p_usuario_id;

  PERFORM _audrec_log(
    'socio.desbloquear', 'socio', p_usuario_id, p_usuario_id, v_socio.nombre,
    format('Levantó el bloqueo. Motivo: %s', p_motivo),
    jsonb_build_object('bloqueado_hasta_anterior', v_socio.bloqueado_hasta, 'motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'bloqueado_hasta', NULL);
END;
$$;

REVOKE ALL ON FUNCTION recepcion_desbloquear_socio(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_desbloquear_socio(uuid, text) TO authenticated;

-- ============================================================================
-- TEST integrado — solo recepcion_congelar_membresia (el más simple). Savepoint
-- + centinela 'ROLLBACK_TEST_3' revierte todo. Mismo patrón que migraciones 1-2.
-- ============================================================================
DO $$
DECLARE
  v_recep        uuid;
  v_recep_auth   uuid;
  v_recep_tenant uuid;
  v_socio_id     uuid;
  v_status       text;
  v_pre  int;
  v_post int;
BEGIN
  SELECT id, auth_id, tenant_id
  INTO v_recep, v_recep_auth, v_recep_tenant
  FROM usuarios
  WHERE rol = 'recepcionista' AND auth_id IS NOT NULL
  LIMIT 1;

  IF v_recep IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay recepcionista con auth_id (los 7 RPCs quedaron creados + GRANT aplicado).';
    RETURN;
  END IF;

  -- Socio del mismo tenant cuya membresía MÁS RECIENTE esté activa (la que congelará).
  SELECT m.usuario_id
  INTO v_socio_id
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE u.tenant_id = v_recep_tenant
    AND u.rol = 'miembro'
    AND m.status = 'activa'
    AND m.created_at = (SELECT max(m2.created_at) FROM membresias m2 WHERE m2.usuario_id = m.usuario_id)
  LIMIT 1;

  IF v_socio_id IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay socio con membresía activa (la más reciente) en el tenant del recepcionista (los 7 RPCs quedaron creados).';
    RETURN;
  END IF;

  SELECT count(*) INTO v_pre FROM auditoria_recepcion;

  BEGIN  -- ── subtransacción reversible ──────────────────────────────────────
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_recep_auth::text)::text,
      true
    );

    PERFORM recepcion_congelar_membresia(v_socio_id, 'Test: congelar integrado');

    SELECT m.status INTO v_status
    FROM membresias m
    WHERE m.usuario_id = v_socio_id
    ORDER BY m.created_at DESC
    LIMIT 1;
    IF v_status <> 'congelada' THEN
      RAISE EXCEPTION 'TEST FAIL: la membresía no quedó congelada (status=%).', v_status;
    END IF;

    SELECT count(*) INTO v_post FROM auditoria_recepcion;
    IF v_post <> v_pre + 1 THEN
      RAISE EXCEPTION 'TEST FAIL: no se insertó la fila de bitácora (pre=% post=%).', v_pre, v_post;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM auditoria_recepcion
      WHERE accion = 'membresia.congelar' AND socio_id = v_socio_id
    ) THEN
      RAISE EXCEPTION 'TEST FAIL: la fila no tiene accion=membresia.congelar / socio esperado.';
    END IF;

    RAISE EXCEPTION 'ROLLBACK_TEST_3';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_TEST_3' THEN
      NULL;  -- ok: subtransacción revertida
    ELSE
      RAISE;
    END IF;
  END;

  SELECT count(*) INTO v_post FROM auditoria_recepcion;
  IF v_post <> v_pre THEN
    RAISE EXCEPTION 'TEST FAIL: la fila de prueba no se revirtió (pre=% post=%).', v_pre, v_post;
  END IF;

  RAISE NOTICE 'TEST OK ✔ recepcion_congelar_membresia funcionó (cambió status + escribió bitácora) y se revirtió.';
END $$;
