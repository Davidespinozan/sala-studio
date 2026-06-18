-- ============================================================================
-- MAPA DE SALÓN · cambiar lugar de una reserva (recepción/admin)
-- ----------------------------------------------------------------------------
-- Permite al staff (recepcionista/admin) mover a un socio de lugar dentro del
-- Mapa de Salón de su clase. Valida: actor staff del tenant, reserva activa,
-- la sala tiene mapa, el lugar existe en el layout y está libre en esa clase.
-- El índice único (clase_id, lugar_id) blinda la carrera igual que al reservar.
-- ============================================================================

CREATE OR REPLACE FUNCTION cambiar_lugar_reserva(
  p_reserva_id uuid,
  p_lugar_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_recurso recursos;
BEGIN
  IF v_actor_tenant IS NULL OR NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción/admin puede cambiar lugares';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva.id IS NULL OR v_reserva.tenant_id <> v_actor_tenant THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe en tu gimnasio';
  END IF;
  IF v_reserva.status NOT IN ('confirmada', 'completada') THEN
    RAISE EXCEPTION 'RESERVA_NO_ACTIVA: La reserva no está activa';
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;
  IF v_recurso.layout IS NULL THEN
    RAISE EXCEPTION 'SALA_SIN_MAPA: Esta sala no usa Mapa de Salón';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l
    WHERE l->>'id' = p_lugar_id
  ) THEN
    RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
  END IF;

  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = v_reserva.clase_id
      AND lugar_id = p_lugar_id
      AND status IN ('confirmada', 'completada')
      AND id <> p_reserva_id
  ) THEN
    RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado';
  END IF;

  UPDATE reservas
  SET lugar_id = p_lugar_id, updated_at = now()
  WHERE id = p_reserva_id;

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id, 'lugar_id', p_lugar_id);
END;
$$;

REVOKE ALL ON FUNCTION cambiar_lugar_reserva(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cambiar_lugar_reserva(uuid, text) TO authenticated;

COMMENT ON FUNCTION cambiar_lugar_reserva(uuid, text) IS
  'Staff (recepción/admin): mueve a un socio a otro lugar del Mapa de Salón de su clase. Valida tenant, reserva activa, lugar válido y libre.';
