-- ============================================================================
-- FIX (menor) — dos limpiezas en RPCs de recepción.
-- ----------------------------------------------------------------------------
-- 1) recepcion_marcar_no_show escribía usuarios.no_shows_count, columna
--    DEPRECADA (20260519000000) que ninguna vista consume — la asistencia se
--    calcula desde reservas.status='no_show'. El UPDATE era código muerto y el
--    copy del modal prometía un "contador" inexistente. Lo quitamos.
-- 2) recepcion_cancelar_membresia no limpiaba el cache usuarios.membresia_tier /
--    membresia_activa_id → la lista de socios seguía mostrando el badge del plan
--    viejo tras cancelar (el acceso sí quedaba bloqueado; era solo visual). Lo
--    limpiamos al cancelar.
-- Ambas funciones recreadas VERBATIM con esos únicos cambios.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- recepcion_marcar_no_show — sin el UPDATE a no_shows_count.
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

  -- La asistencia se computa desde reservas.status='no_show'; la columna
  -- contadora deprecada (20260519000000) ya no se toca.
  UPDATE reservas SET status = 'no_show', updated_at = now() WHERE id = p_reserva_id;

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
-- recepcion_cancelar_membresia — limpia el cache de plan en usuarios.
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

  -- Limpiar el cache denormalizado para que la lista de socios no muestre el
  -- plan viejo (el badge lee usuarios.membresia_tier).
  UPDATE usuarios
  SET membresia_tier = NULL, membresia_activa_id = NULL
  WHERE id = p_usuario_id;

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

-- ============================================================================
-- TEST — no_show ya no toca no_shows_count; cancelar limpia el cache de plan.
-- ============================================================================
DO $$
DECLARE v_ns text; v_cancel text;
BEGIN
  SELECT pg_get_functiondef('recepcion_marcar_no_show(uuid, text)'::regprocedure) INTO v_ns;
  IF position('no_shows_count' in v_ns) > 0 THEN
    RAISE EXCEPTION 'TEST FALLO: recepcion_marcar_no_show todavía escribe no_shows_count.';
  END IF;

  SELECT pg_get_functiondef('recepcion_cancelar_membresia(uuid, text)'::regprocedure) INTO v_cancel;
  IF position('membresia_tier = NULL' in v_cancel) = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: recepcion_cancelar_membresia no limpia el cache de plan.';
  END IF;

  RAISE NOTICE 'TEST OK: no_show sin no_shows_count; cancelar limpia usuarios.membresia_tier.';
END $$;
