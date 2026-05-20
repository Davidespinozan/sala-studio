-- ============================================================================
-- S4.4 — Funciones SQL conscientes de la timezone del tenant
-- ============================================================================
-- Elimina el hardcode 'America/Mexico_City'. Ambas funciones ahora leen
-- tenants.config->>'timezone' (fallback 'America/Mexico_City' si la key no
-- existe).
--
--   A) reservar_clase_atomic   — la conversión fecha+hora → instante usa la
--                                tz del tenant
--   B) generar_clases_recurrentes — "hoy" se calcula en la tz del tenant
--                                   (now() AT TIME ZONE tz), no en UTC
--
-- Solo CREATE OR REPLACE: firmas idénticas, los GRANT existentes se preservan.
-- ============================================================================

-- ============================================================================
-- A) reservar_clase_atomic — tz del tenant
-- ============================================================================

CREATE OR REPLACE FUNCTION reservar_clase_atomic(
  p_clase_id uuid,
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
  v_clase clases;
  v_recurso recursos;
  v_tenant tenants;
  v_now timestamptz := now();
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_min_anticipacion_h integer;
  v_max_invitados integer;
  v_cupos_ocupados integer;
  v_existe_doble boolean;
  v_existe_continua boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = p_clase_id;
  SELECT * INTO v_tenant  FROM tenants  WHERE id = v_tenant_id;

  -- S4.4: timezone del tenant (fallback al default).
  v_tz := COALESCE(v_tenant.config->>'timezone', 'America/Mexico_City');

  IF v_clase IS NULL OR v_clase.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;

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

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_usuario.membresia_tier IS NULL OR
     NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
    RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
  END IF;

  v_max_invitados := max_invitados_por_tier(v_usuario.membresia_tier);
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  v_min_anticipacion_h := COALESCE((v_tenant.config->>'min_anticipacion_horas')::integer, 24);
  IF v_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
  END IF;

  -- Doble reserva del mismo usuario en la misma clase
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE clase_id = p_clase_id
      AND usuario_id = v_user_id
      AND status IN ('confirmada','completada')
  ) INTO v_existe_doble;
  IF v_existe_doble THEN
    RAISE EXCEPTION 'YA_RESERVADO: Ya tenés una reserva activa en esta clase';
  END IF;

  -- Horas continuas (mismo usuario, slot adyacente en cualquier clase)
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE usuario_id = v_user_id
      AND status IN ('confirmada','completada')
      AND (slot_fin = v_slot_inicio OR slot_inicio = v_slot_fin)
  ) INTO v_existe_continua;
  IF v_existe_continua THEN
    RAISE EXCEPTION 'CONTINUA: No puedes reservar horas continuas';
  END IF;

  -- Cupo
  SELECT count(*) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada','completada');

  IF v_cupos_ocupados >= v_clase.cupo_max THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_clase.cupo_max;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'EKK-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas,
    clase_id
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, v_user_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas,
    p_clase_id
  )
  RETURNING id INTO v_reserva_id;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', p_clase_id
  );
END;
$$;

-- ============================================================================
-- B) generar_clases_recurrentes — "hoy" en la tz del tenant
-- ============================================================================

CREATE OR REPLACE FUNCTION generar_clases_recurrentes(
  p_tenant_id uuid,
  p_dias_forward integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clases_creadas integer := 0;
  v_tz text;
  v_hoy date;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id no puede ser NULL';
  END IF;
  IF p_dias_forward < 1 OR p_dias_forward > 365 THEN
    RAISE EXCEPTION 'p_dias_forward fuera de rango razonable [1, 365]: %', p_dias_forward;
  END IF;

  -- S4.4: "hoy" se calcula en la tz del tenant, no en UTC del servidor.
  SELECT COALESCE(config->>'timezone', 'America/Mexico_City')
    INTO v_tz
    FROM tenants
    WHERE id = p_tenant_id;

  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'Tenant % no existe', p_tenant_id;
  END IF;

  v_hoy := (now() AT TIME ZONE v_tz)::date;

  WITH bloques AS (
    SELECT
      r.id                       AS recurso_id,
      r.tenant_id,
      r.nombre                   AS recurso_nombre,
      r.cupo_max_default,
      r.tipo_contenido,
      h->>'dia'                  AS dia_nombre,
      (h->>'inicio')::time       AS hora_inicio_block,
      (h->>'fin')::time          AS hora_fin_block,
      -- serie_id determinístico: misma serie para el mismo bloque en re-runs.
      md5(r.id::text || '|' || (h->>'dia') || '|' || (h->>'inicio'))::uuid AS serie_id
    FROM recursos r
    CROSS JOIN LATERAL jsonb_array_elements(r.horarios) h
    WHERE r.tenant_id = p_tenant_id
      AND r.activo = true
  ),
  bloques_validos AS (
    -- Filtra bloques de duración no positiva y los que cruzan medianoche.
    SELECT *
    FROM bloques
    WHERE hora_fin_block > hora_inicio_block
  ),
  fechas AS (
    SELECT generate_series(
      v_hoy,
      v_hoy + (p_dias_forward || ' days')::interval,
      '1 day'::interval
    )::date AS fecha
  ),
  fechas_etiquetadas AS (
    SELECT
      f.fecha,
      CASE EXTRACT(DOW FROM f.fecha)::int
        WHEN 0 THEN 'domingo'
        WHEN 1 THEN 'lunes'
        WHEN 2 THEN 'martes'
        WHEN 3 THEN 'miercoles'
        WHEN 4 THEN 'jueves'
        WHEN 5 THEN 'viernes'
        WHEN 6 THEN 'sabado'
      END AS dia_nombre
    FROM fechas f
  )
  INSERT INTO clases (
    tenant_id, recurso_id, fecha, hora_inicio, duracion_minutos,
    nombre, disciplina, cupo_max, origen, serie_id, status
  )
  SELECT
    b.tenant_id,
    b.recurso_id,
    f.fecha,
    b.hora_inicio_block,
    (EXTRACT(EPOCH FROM (b.hora_fin_block - b.hora_inicio_block)) / 60)::integer,
    CASE
      WHEN COALESCE(b.tipo_contenido[1], '') = '' THEN
        b.recurso_nombre
      WHEN position(lower(b.tipo_contenido[1]) IN lower(b.recurso_nombre)) > 0 THEN
        b.recurso_nombre
      ELSE
        b.recurso_nombre || ' · ' || b.tipo_contenido[1]
    END,
    b.tipo_contenido[1],
    b.cupo_max_default,
    'recurrente',
    b.serie_id,
    'programada'
  FROM bloques_validos b
  JOIN fechas_etiquetadas f ON f.dia_nombre = b.dia_nombre
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_clases_creadas = ROW_COUNT;

  RETURN jsonb_build_object(
    'clases_creadas', v_clases_creadas,
    'tenant_id', p_tenant_id,
    'timezone', v_tz,
    'dias_forward', p_dias_forward,
    'fecha_desde', v_hoy,
    'fecha_hasta', v_hoy + p_dias_forward,
    'ts', now()
  );
END $$;

COMMENT ON FUNCTION reservar_clase_atomic(uuid, integer, text) IS
  'S4.4: reserva una clase por clase_id. Convierte fecha+hora con la timezone del tenant (config.timezone, fallback America/Mexico_City).';
COMMENT ON FUNCTION generar_clases_recurrentes(uuid, integer) IS
  'S4.4: genera clases instancia desde recursos.horarios. "Hoy" se calcula en la timezone del tenant. Idempotente.';
