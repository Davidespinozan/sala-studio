-- ============================================================================
-- Reglas operativas: invitados por tier + no-shows + commitment
-- ============================================================================

-- 1. Función helper para obtener máximo de invitados por tier
CREATE OR REPLACE FUNCTION max_invitados_por_tier(p_tier text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_tier
    WHEN 'basica' THEN 2
    WHEN 'pro' THEN 4
    ELSE 0
  END;
$$;

GRANT EXECUTE ON FUNCTION max_invitados_por_tier(text) TO authenticated;

-- 2. Actualizar reservar_recurso_atomic para validar invitados
CREATE OR REPLACE FUNCTION reservar_recurso_atomic(
  p_recurso_id uuid,
  p_slot_inicio timestamptz,
  p_duracion_min integer,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL
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
  v_recurso recursos;
  v_tenant tenants;
  v_slot_fin timestamptz;
  v_now timestamptz := now();
  v_min_anticipacion_h integer;
  v_max_invitados integer;
  v_existe_continua boolean;
  v_existe_doble boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = p_recurso_id;
  SELECT * INTO v_tenant FROM tenants WHERE id = v_tenant_id;

  -- Validar status del usuario
  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'EKKO_USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  -- Validar bloqueo
  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'EKKO_USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  -- Validar recurso
  IF v_recurso IS NULL OR v_recurso.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_RECURSO_NO_EXISTE: Estudio no encontrado';
  END IF;

  IF NOT v_recurso.activo THEN
    RAISE EXCEPTION 'EKKO_RECURSO_INACTIVO: Este estudio no está disponible';
  END IF;

  -- Validar tier permitido
  IF v_usuario.membresia_tier IS NULL OR
     NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
    RAISE EXCEPTION 'EKKO_TIER_NO_PERMITIDO: Tu plan no tiene acceso a este estudio';
  END IF;

  -- Validar invitados según tier
  v_max_invitados := max_invitados_por_tier(v_usuario.membresia_tier);
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
  END IF;

  -- Calcular fin
  v_slot_fin := p_slot_inicio + (p_duracion_min || ' minutes')::interval;

  -- Validar anticipación
  v_min_anticipacion_h := COALESCE((v_tenant.config->>'min_anticipacion_horas')::integer, 24);
  IF p_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'EKKO_ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
  END IF;

  -- Validar no continuas
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE usuario_id = v_user_id
      AND status IN ('confirmada', 'completada')
      AND (slot_fin = p_slot_inicio OR slot_inicio = v_slot_fin)
  ) INTO v_existe_continua;

  IF v_existe_continua THEN
    RAISE EXCEPTION 'EKKO_CONTINUA: No puedes reservar horas continuas';
  END IF;

  -- Validar no doble-booking del recurso
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE recurso_id = p_recurso_id
      AND status IN ('confirmada', 'completada')
      AND tstzrange(slot_inicio, slot_fin, '[)') && tstzrange(p_slot_inicio, v_slot_fin, '[)')
  ) INTO v_existe_doble;

  IF v_existe_doble THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya está reservado';
  END IF;

  -- Generar folio
  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'EKK-' || lpad((v_folio_count + 1)::text, 6, '0');

  -- Crear reserva
  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    cupos, status, folio, notas
  ) VALUES (
    v_tenant_id, p_recurso_id, v_user_id,
    p_slot_inicio, v_slot_fin, p_duracion_min,
    1 + p_invitados, 'confirmada', v_folio_nuevo, p_notas
  ) RETURNING id INTO v_reserva_id;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo
  );
END;
$$;

-- 3. Función para marcar no-shows en batch (la llama el cron)
CREATE OR REPLACE FUNCTION marcar_no_shows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservas_afectadas integer := 0;
  v_usuarios_bloqueados integer := 0;
  v_now timestamptz := now();
  r record;
BEGIN
  -- Marcar reservas no asistidas
  FOR r IN
    SELECT id, usuario_id, tenant_id, folio
    FROM reservas
    WHERE status = 'confirmada'
      AND check_in_at IS NULL
      AND slot_fin + interval '30 minutes' < v_now
  LOOP
    UPDATE reservas SET status = 'no_show' WHERE id = r.id;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    -- Incrementar contador y bloquear al usuario
    UPDATE usuarios
    SET no_shows_count = no_shows_count + 1,
        bloqueado_hasta = GREATEST(
          COALESCE(bloqueado_hasta, v_now),
          v_now + interval '7 days'
        )
    WHERE id = r.usuario_id;
    v_usuarios_bloqueados := v_usuarios_bloqueados + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'timestamp', v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION marcar_no_shows() TO authenticated;

-- 4. Programar el cron de no-shows con pg_cron (si está disponible)
-- Si pg_cron NO está habilitado en Supabase, se llama desde una Netlify
-- Function programada en lugar de pg_cron — más portable. Saltamos esto
-- aquí y lo manejamos desde el lado del backend.

COMMENT ON FUNCTION marcar_no_shows IS
  'Marca como no_show las reservas no asistidas y bloquea al usuario 1 semana.
   Llamar desde un cron externo (Netlify scheduled function) cada hora.';
