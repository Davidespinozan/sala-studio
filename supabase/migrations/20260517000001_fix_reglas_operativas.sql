-- ============================================================================
-- Sprint A · Verdad funcional admin → sistema
-- ============================================================================
-- Fix: el RPC reservar_recurso_atomic y la función marcar_no_shows
-- ignoraban silenciosamente las reglas que admin edita en tenant.config y
-- en tiers.reglas. Esta migración hace que el backend lea esas claves
-- correctamente (con paths anidados y fallback a las claves planas
-- legacy + defaults seguros).
--
-- Cambios:
--   1. reservar_recurso_atomic
--      - Lee tenant.config->'reserva'->>'anticipacion_min_horas'
--        (antes: 'min_anticipacion_horas' plano → siempre default 24)
--      - Respeta tenant.config->'reserva'->>'permitir_continuas'
--        (antes: prohibía continuas siempre)
--      - Lee max_invitados desde tiers.reglas->>'max_invitados'
--        (antes: función max_invitados_por_tier con CASE hardcoded 2/4)
--      - Valida que el slot caiga dentro de algún bloque de
--        recursos.horarios (antes: no validaba, sólo lo hacía el cliente)
--   2. marcar_no_shows
--      - Lee tenant.config->'penalizaciones'->>'no_show_bloqueo_dias'
--        (antes: interval '7 days' hardcoded)
--
-- Conserva del RPC original:
--   - Firma 5-param (p_recurso_id, p_slot_inicio, p_duracion_min,
--     p_invitados, p_notas)
--   - Patrón RAISE EXCEPTION 'EKKO_<CODIGO>: mensaje'
--   - Uso de helpers get_my_user_id() / get_my_tenant_id()
--   - Columna slot_fin computada en reservas
--   - Overlap por tstzrange (no point-match)
--   - Folio = 'EKK-' || count(*)+1 padded
-- ============================================================================

-- Eliminar la firma legacy de 4 parámetros (uuid, timestamptz, integer, text)
-- que viene de la migración 100900. El frontend solo llama a la 5-param
-- (ver src/member/hooks/useReservas.ts) y la 4-param quedó como overload
-- huérfano que generaba ambigüedad en COMMENT ON FUNCTION.
DROP FUNCTION IF EXISTS reservar_recurso_atomic(uuid, timestamptz, integer, text);

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
  v_permitir_continuas boolean;
  v_max_invitados integer;
  v_existe_continua boolean;
  v_existe_doble boolean;
  v_dia_semana text;
  v_slot_dentro_horario boolean;
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
  SELECT * INTO v_tenant  FROM tenants  WHERE id = v_tenant_id;

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'EKKO_USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'EKKO_USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_recurso IS NULL OR v_recurso.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_RECURSO_NO_EXISTE: Estudio no encontrado';
  END IF;

  IF NOT v_recurso.activo THEN
    RAISE EXCEPTION 'EKKO_RECURSO_INACTIVO: Este estudio no está disponible';
  END IF;

  IF v_usuario.membresia_tier IS NULL OR
     NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
    RAISE EXCEPTION 'EKKO_TIER_NO_PERMITIDO: Tu plan no tiene acceso a este estudio';
  END IF;

  -- ============================================================
  -- max_invitados: leer de tiers.reglas (fallback a CASE hardcoded)
  -- ============================================================
  SELECT COALESCE(
    (t.reglas->>'max_invitados')::integer,
    CASE v_usuario.membresia_tier
      WHEN 'pro' THEN 4
      WHEN 'basica' THEN 2
      ELSE 0
    END
  )
  INTO v_max_invitados
  FROM tiers t
  WHERE t.tenant_id = v_tenant_id
    AND t.slug = v_usuario.membresia_tier;

  -- Si el tier no existe en BD, usar fallback CASE
  IF v_max_invitados IS NULL THEN
    v_max_invitados := CASE v_usuario.membresia_tier
      WHEN 'pro' THEN 4
      WHEN 'basica' THEN 2
      ELSE 0
    END;
  END IF;

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_fin := p_slot_inicio + (p_duracion_min || ' minutes')::interval;

  -- ============================================================
  -- Anticipación mínima: leer config con path anidado + fallback
  -- ============================================================
  v_min_anticipacion_h := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer,
    (v_tenant.config->>'min_anticipacion_horas')::integer,
    24
  );

  IF p_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'EKKO_ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
  END IF;

  -- ============================================================
  -- Horario del recurso: el slot debe caer dentro de un bloque del día
  -- (locale-independiente: matchea por EXTRACT DOW → nombre español)
  -- Si no hay horarios configurados, fail-open (admin lo definirá).
  -- ============================================================
  IF v_recurso.horarios IS NOT NULL AND jsonb_array_length(v_recurso.horarios) > 0 THEN
    v_dia_semana := CASE EXTRACT(DOW FROM p_slot_inicio)::integer
      WHEN 0 THEN 'domingo'
      WHEN 1 THEN 'lunes'
      WHEN 2 THEN 'martes'
      WHEN 3 THEN 'miercoles'
      WHEN 4 THEN 'jueves'
      WHEN 5 THEN 'viernes'
      WHEN 6 THEN 'sabado'
    END;

    SELECT EXISTS(
      SELECT 1
      FROM jsonb_array_elements(v_recurso.horarios) AS bloque
      WHERE bloque->>'dia' = v_dia_semana
        AND (bloque->>'inicio')::time <= p_slot_inicio::time
        AND (bloque->>'fin')::time   >= v_slot_fin::time
    ) INTO v_slot_dentro_horario;

    IF NOT v_slot_dentro_horario THEN
      RAISE EXCEPTION 'EKKO_FUERA_DE_HORARIO: Este horario no está disponible para este estudio';
    END IF;
  END IF;

  -- ============================================================
  -- Reservas continuas: respetar flag del tenant.config
  -- (default: prohibidas, mismo comportamiento que antes)
  -- ============================================================
  v_permitir_continuas := COALESCE(
    (v_tenant.config->'reserva'->>'permitir_continuas')::boolean,
    (v_tenant.config->>'permitir_continuas')::boolean,
    false
  );

  IF NOT v_permitir_continuas THEN
    SELECT EXISTS(
      SELECT 1 FROM reservas
      WHERE usuario_id = v_user_id
        AND status IN ('confirmada', 'completada')
        AND (slot_fin = p_slot_inicio OR slot_inicio = v_slot_fin)
    ) INTO v_existe_continua;

    IF v_existe_continua THEN
      RAISE EXCEPTION 'EKKO_CONTINUA: No puedes reservar horas continuas';
    END IF;
  END IF;

  -- Overlap (slot ya ocupado)
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE recurso_id = p_recurso_id
      AND status IN ('confirmada', 'completada')
      AND tstzrange(slot_inicio, slot_fin, '[)') && tstzrange(p_slot_inicio, v_slot_fin, '[)')
  ) INTO v_existe_doble;

  IF v_existe_doble THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya está reservado';
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'EKK-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas
  ) VALUES (
    v_tenant_id, p_recurso_id, v_user_id,
    p_slot_inicio, v_slot_fin, p_duracion_min,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas
  ) RETURNING id INTO v_reserva_id;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo
  );
END;
$$;

COMMENT ON FUNCTION reservar_recurso_atomic(uuid, timestamptz, integer, integer, text) IS
'Crea una reserva atómica validando status/bloqueo del usuario, anticipación
mínima (config.reserva.anticipacion_min_horas con fallback a clave plana y
default 24h), tier permitido, max_invitados (tiers.reglas.max_invitados con
fallback CASE basica=2/pro=4), horarios del recurso (locale-independiente),
regla de no-continuas (config.reserva.permitir_continuas, default false), y
overlap con tstzrange. Folio = EKK-{count+1 padded}.';


-- ============================================================================
-- marcar_no_shows: leer no_show_bloqueo_dias de tenant.config
-- ============================================================================

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
  v_bloqueo_dias integer;
  r record;
BEGIN
  FOR r IN
    SELECT
      res.id,
      res.usuario_id,
      res.tenant_id,
      res.folio,
      t.config AS tenant_config
    FROM reservas res
    JOIN tenants t ON t.id = res.tenant_id
    WHERE res.status = 'confirmada'
      AND res.check_in_at IS NULL
      AND res.slot_fin + interval '30 minutes' < v_now
  LOOP
    v_bloqueo_dias := COALESCE(
      (r.tenant_config->'penalizaciones'->>'no_show_bloqueo_dias')::integer,
      (r.tenant_config->>'no_show_bloqueo_dias')::integer,
      7
    );

    UPDATE reservas SET status = 'no_show' WHERE id = r.id;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    UPDATE usuarios
    SET no_shows_count = no_shows_count + 1,
        bloqueado_hasta = GREATEST(
          COALESCE(bloqueado_hasta, v_now),
          v_now + (v_bloqueo_dias || ' days')::interval
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

COMMENT ON FUNCTION marcar_no_shows() IS
'Marca como no_show las reservas confirmadas cuyo slot_fin+30min ya pasó sin
check-in, e incrementa no_shows_count + bloqueado_hasta del usuario por la
cantidad de días definida en tenant.config.penalizaciones.no_show_bloqueo_dias
(fallback a clave plana, default 7 días). Llamar desde cron externo cada hora.';
