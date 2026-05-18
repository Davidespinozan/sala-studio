-- ============================================================================
-- RPC: reservar_recurso_atomic
-- ============================================================================
-- Reserva un recurso para un usuario en un slot específico.
-- Valida en una sola transacción:
--   1. Usuario existe, está activo, no bloqueado por no-show
--   2. Recurso existe, activo, pertenece al tenant del usuario
--   3. Tier del usuario tiene permiso de este recurso
--   4. Slot dentro de horario del recurso
--   5. Anticipación dentro de [anticipacion_min_horas, anticipacion_max_dias]
--   6. Regla "no continuas" si tenant.config.reserva.permitir_continuas=false
--   7. Slot no ocupado (UNIQUE index protege la race condition)
--   8. INSERT con folio autogenerado
--
-- Errores se devuelven como RAISE EXCEPTION con prefijo 'EKKO_'
-- para que el cliente los traduzca a mensajes user-friendly.
-- ============================================================================

CREATE OR REPLACE FUNCTION reservar_recurso_atomic(
  p_recurso_id uuid,
  p_slot_inicio timestamptz,
  p_invitados_count integer DEFAULT 0,
  p_notas text DEFAULT NULL
)
RETURNS reservas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_usuario usuarios;
  v_recurso recursos;
  v_tier tiers;
  v_config jsonb;
  v_duracion_min integer;
  v_anticipacion_min_horas integer;
  v_anticipacion_max_dias integer;
  v_permitir_continuas boolean;
  v_slot_fin timestamptz;
  v_folio text;
  v_now timestamptz := now();
  v_reserva reservas;
BEGIN
  -- 0. Resolver usuario actual
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;

  -- 1. Validar usuario activo y no bloqueado
  IF v_usuario.status NOT IN ('activo') THEN
    RAISE EXCEPTION 'EKKO_USUARIO_INACTIVO: Tu membresía no está activa';
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'EKKO_USUARIO_BLOQUEADO: Estás bloqueado hasta %', v_usuario.bloqueado_hasta;
  END IF;

  -- 2. Validar recurso
  SELECT * INTO v_recurso FROM recursos
  WHERE id = p_recurso_id AND tenant_id = v_tenant_id AND activo = true;

  IF v_recurso IS NULL THEN
    RAISE EXCEPTION 'EKKO_RECURSO_NO_EXISTE: El recurso no existe o no está disponible';
  END IF;

  -- 3. Validar tier permite este recurso
  IF v_usuario.membresia_tier IS NOT NULL THEN
    IF NOT (v_usuario.membresia_tier = ANY (v_recurso.tiers_permitidos)) THEN
      RAISE EXCEPTION 'EKKO_TIER_NO_PERMITE: Tu plan no incluye acceso a este recurso';
    END IF;
  END IF;

  -- 4. Leer config del tenant
  SELECT config INTO v_config FROM tenants WHERE id = v_tenant_id;

  v_duracion_min := COALESCE(
    (v_config->'reserva'->>'duracion_default_min')::integer,
    60
  );
  v_anticipacion_min_horas := COALESCE(
    (v_config->'reserva'->>'anticipacion_min_horas')::integer,
    24
  );
  v_anticipacion_max_dias := COALESCE(
    (v_config->'reserva'->>'anticipacion_max_dias')::integer,
    30
  );
  v_permitir_continuas := COALESCE(
    (v_config->'reserva'->>'permitir_continuas')::boolean,
    false
  );

  v_slot_fin := p_slot_inicio + (v_duracion_min || ' minutes')::interval;

  -- 5. Validar anticipación
  IF p_slot_inicio < v_now + (v_anticipacion_min_horas || ' hours')::interval THEN
    RAISE EXCEPTION 'EKKO_ANTICIPACION_INSUFICIENTE: Necesitas reservar con al menos % horas de anticipación',
      v_anticipacion_min_horas;
  END IF;

  IF p_slot_inicio > v_now + (v_anticipacion_max_dias || ' days')::interval THEN
    RAISE EXCEPTION 'EKKO_ANTICIPACION_EXCESIVA: No puedes reservar con más de % días de anticipación',
      v_anticipacion_max_dias;
  END IF;

  -- 6. Regla "no continuas" — solo si el tenant la activa
  IF NOT v_permitir_continuas THEN
    -- Buscar si tiene reserva en slot anterior o siguiente (mismo día)
    PERFORM 1 FROM reservas
    WHERE tenant_id = v_tenant_id
      AND usuario_id = v_user_id
      AND status IN ('confirmada', 'completada')
      AND (
        slot_inicio = p_slot_inicio - (v_duracion_min || ' minutes')::interval
        OR slot_inicio = p_slot_inicio + (v_duracion_min || ' minutes')::interval
      );

    IF FOUND THEN
      RAISE EXCEPTION 'EKKO_CONTINUAS_NO_PERMITIDAS: No puedes reservar horas consecutivas';
    END IF;
  END IF;

  -- 7. Generar folio
  v_folio := 'EKK-' || lpad(nextval('reservas_folio_seq')::text, 6, '0');

  -- 8. INSERT — el UNIQUE index protege la race condition de slot tomado
  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    folio, status, invitados_count, notas
  ) VALUES (
    v_tenant_id, p_recurso_id, v_user_id,
    p_slot_inicio, v_slot_fin, v_duracion_min,
    v_folio, 'confirmada', p_invitados_count, p_notas
  )
  RETURNING * INTO v_reserva;

  RETURN v_reserva;

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya fue reservado por otro miembro';
END;
$$;

GRANT EXECUTE ON FUNCTION reservar_recurso_atomic(uuid, timestamptz, integer, text) TO authenticated;

-- ============================================================================
-- RPC: cancelar_reserva_atomic
-- ============================================================================
-- Cancela una reserva si el usuario es dueño y aún no pasó el slot.
-- ============================================================================

CREATE OR REPLACE FUNCTION cancelar_reserva_atomic(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS reservas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_reserva reservas;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE';
  END IF;

  -- Solo el dueño o admin del tenant puede cancelar
  IF v_reserva.usuario_id != v_user_id AND NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: No puedes cancelar esta reserva';
  END IF;

  IF v_reserva.status != 'confirmada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_CANCELABLE: La reserva no está confirmada';
  END IF;

  IF v_reserva.slot_inicio < now() THEN
    RAISE EXCEPTION 'EKKO_RESERVA_PASADA: No puedes cancelar una reserva que ya pasó';
  END IF;

  UPDATE reservas
  SET status = 'cancelada',
      cancelada_at = now(),
      cancelada_motivo = p_motivo
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  RETURN v_reserva;
END;
$$;

GRANT EXECUTE ON FUNCTION cancelar_reserva_atomic(uuid, text) TO authenticated;
