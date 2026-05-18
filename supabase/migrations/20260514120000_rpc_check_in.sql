-- ============================================================================
-- RPC: check_in_atomic
-- ============================================================================
-- Marca una reserva como completada por check-in en recepción.
-- Validaciones:
--   1. Recepcionista o admin autenticado
--   2. Reserva existe y pertenece al tenant del recepcionista
--   3. Reserva en estado 'confirmada' (no cancelada ni completada)
--   4. Slot dentro de ventana de check-in (15 min antes inicio - 30 min después fin)
--   5. Marca check_in_at + check_in_by + status='completada'
--   6. Devuelve la reserva + datos del miembro para mostrar en pantalla
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
  -- 1. Resolver usuario actual y validar rol
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo admin o recepcionista pueden hacer check-in';
  END IF;

  -- 2. Obtener reserva
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  -- 3. Validar estado
  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'EKKO_YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  -- 4. Ventana de check-in: 15 min antes del slot hasta 30 min después de fin
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

  -- 5. Marcar check-in
  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  -- 6. Obtener datos del miembro y recurso para mostrar
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

GRANT EXECUTE ON FUNCTION check_in_atomic(uuid) TO authenticated;

-- ============================================================================
-- HELPER DEV: crear cuenta de recepcionista
-- ============================================================================

CREATE OR REPLACE FUNCTION dev_crear_recepcionista(p_email text, p_nombre text)
RETURNS usuarios
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ekko_tenant_id uuid;
  v_usuario usuarios;
BEGIN
  SELECT id INTO v_ekko_tenant_id FROM tenants WHERE slug = 'ekko';

  IF v_ekko_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant ekko no existe';
  END IF;

  -- Si ya existe el usuario, solo cambiar su rol
  UPDATE usuarios
  SET rol = 'recepcionista', status = 'activo'
  WHERE lower(email) = lower(p_email) AND tenant_id = v_ekko_tenant_id
  RETURNING * INTO v_usuario;

  IF v_usuario IS NOT NULL THEN
    RETURN v_usuario;
  END IF;

  -- Si no existe, crear sin auth_id (David debe hacer signup desde la app
  -- y después correr este helper para ascenderlo)
  RAISE EXCEPTION 'Usuario % no existe. Primero crea cuenta en /signup, después corre este helper.', p_email;
END;
$$;

COMMENT ON FUNCTION dev_crear_recepcionista IS
  'DEV ONLY: asciende un usuario existente a rol recepcionista. Eliminar antes de producción.';
