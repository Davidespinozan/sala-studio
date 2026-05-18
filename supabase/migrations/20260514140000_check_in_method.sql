-- ============================================================================
-- Audit: check_in_method
-- ============================================================================
-- Agrega columna para auditar cómo se hizo cada check-in (QR vs manual).
-- Útil para detectar problemas (muchos manuales → algo está mal con QRs).
-- ============================================================================

ALTER TABLE reservas
ADD COLUMN IF NOT EXISTS check_in_method text
  CHECK (check_in_method IS NULL OR check_in_method IN ('qr', 'manual'));

COMMENT ON COLUMN reservas.check_in_method IS
  'Método de check-in: qr (escaneo normal) o manual (recepción sin QR).
   NULL si aún no hubo check-in.';

-- ============================================================================
-- Actualizar check_in_atomic para marcar method='qr'
-- ============================================================================

CREATE OR REPLACE FUNCTION check_in_atomic(
  p_reserva_id uuid
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
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo admin o recepcionista pueden hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'EKKO_YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  v_ventana_inicio := v_reserva.slot_inicio - interval '15 minutes';
  v_ventana_fin := v_reserva.slot_fin + interval '30 minutes';

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TEMPRANO: El check-in abre 15 min antes del horario (a las %)',
      to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TARDE: El check-in cerró a las %',
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

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'avatar_url', v_miembro.avatar_url
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    )
  );
END;
$$;

-- ============================================================================
-- check_in_manual_atomic — sin JWT, para casos sin QR
-- ============================================================================

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
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo admin o recepcionista pueden hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'EKKO_YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  -- Ventana más permisiva en manual: 30 min antes y 1h después
  -- (la recepcionista decide, ya valida visualmente)
  v_ventana_inicio := v_reserva.slot_inicio - interval '30 minutes';
  v_ventana_fin := v_reserva.slot_fin + interval '60 minutes';

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TEMPRANO: El check-in manual abre 30 min antes (a las %)',
      to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TARDE: El check-in manual cerró a las %',
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

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'avatar_url', v_miembro.avatar_url
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_in_manual_atomic(uuid, text) TO authenticated;
