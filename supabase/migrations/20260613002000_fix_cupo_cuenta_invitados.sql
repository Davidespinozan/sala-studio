-- ============================================================================
-- FIX (decisión: cupo = personas) — invitados ocupan cupo.
-- ----------------------------------------------------------------------------
-- El gate contaba count(*) de reservas e ignoraba invitados_count → una clase
-- cupo_max=10 con 10 reservas + invitados metía >10 personas a la sala. Ahora
-- cupo = PERSONAS: cada reserva ocupa 1 + sus invitados. Se recrea el gate
-- (reservar_clase_atomic, de 20260613001900) y expandir_clases (de
-- 20260613001500) para que el conteo de cupos display sea consistente.
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
  v_permitir_continuas boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  -- Rol y gate de membresía
  v_es_socio boolean;
  v_mem_id uuid;
  v_mem_status text;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_nuevo_creditos integer;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = p_clase_id;
  SELECT * INTO v_tenant  FROM tenants  WHERE id = v_tenant_id;

  IF v_clase IS NULL OR v_clase.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;

  -- multisede-3: la tz es la de la SUCURSAL de la clase (fallback a la del tenant).
  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);

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

  -- Solo el rol 'miembro' está sujeto a gate/tier/débito. Los demás (admin,
  -- recepcionista, staff) operan por rol y bypassean toda la lógica de
  -- membresía.
  v_es_socio := v_usuario.rol = 'miembro';

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- GATE de membresía (solo socios). FOR UPDATE serializa el débito.
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio THEN
    SELECT m.id, m.status, m.periodo_actual_fin, m.creditos_restantes, t.tipo
    INTO v_mem_id, v_mem_status, v_mem_fin, v_mem_creditos, v_tier_tipo
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_user_id
      AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
    ORDER BY
      -- Si por algún motivo hay más de una fila "vigente", priorizar la más
      -- útil. activa > trialing > past_due > congelada; luego más reciente.
      CASE m.status
        WHEN 'activa'    THEN 0
        WHEN 'trialing'  THEN 1
        WHEN 'past_due'  THEN 2
        WHEN 'congelada' THEN 3
      END,
      m.created_at DESC
    LIMIT 1
    FOR UPDATE OF m;

    IF v_mem_id IS NULL THEN
      RAISE EXCEPTION 'SIN_MEMBRESIA: No tenés una membresía activa';
    END IF;

    IF v_mem_status = 'congelada' THEN
      RAISE EXCEPTION 'MEMBRESIA_CONGELADA: Tu membresía está pausada';
    END IF;

    -- Vencimiento — la política la encoda periodo_actual_fin, no el tipo
    -- (tipo=tiempo y tipo=hibrido SIEMPRE tienen fin; tipo=creditos puede
    -- tener fin si el paquete caduca, o NULL si son créditos puros eternos).
    IF v_mem_fin IS NOT NULL AND v_mem_fin <= v_now THEN
      RAISE EXCEPTION 'MEMBRESIA_VENCIDA: Tu membresía venció el %',
        to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
    END IF;

    -- Saldo — solo tipos con créditos
    IF v_tier_tipo IN ('creditos', 'hibrido')
       AND COALESCE(v_mem_creditos, 0) <= 0 THEN
      RAISE EXCEPTION 'SIN_CREDITOS: Te quedaste sin créditos en tu paquete';
    END IF;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Tier permitido por el RECURSO (existente, solo socios)
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio THEN
    IF v_usuario.membresia_tier IS NULL OR
       NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
      RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
    END IF;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Invitados — el techo (EXCEDEN) aplica solo a socios; el validador de
  -- número negativo aplica a todos.
  -- ───────────────────────────────────────────────────────────────────────
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF v_es_socio THEN
    -- Nada hardcodeado: el máximo de invitados del tier del socio sale de
    -- tiers.reglas (editable por el admin), por tenant. Fallback a la función
    -- legacy max_invitados_por_tier solo si el tier no lo definió.
    v_max_invitados := COALESCE(
      (SELECT (t.reglas->>'max_invitados')::int FROM tiers t
        WHERE t.tenant_id = v_tenant_id AND t.slug = v_usuario.membresia_tier),
      max_invitados_por_tier(v_usuario.membresia_tier)
    );
    IF p_invitados > v_max_invitados THEN
      RAISE EXCEPTION 'INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
    END IF;
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  -- fix #3: el admin guarda config.reserva.anticipacion_min_horas (AjustesReglas).
  -- 'min_anticipacion_horas' plano es legacy y nadie lo escribe → leemos la
  -- clave anidada con fallback a la plana y default 24. (20260524200000 había
  -- regresado a la plana, ignorando la config del admin → siempre 24h.)
  v_min_anticipacion_h := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer,
    (v_tenant.config->>'min_anticipacion_horas')::integer,
    24);
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

  -- Horas continuas (mismo usuario, slot adyacente en cualquier clase).
  -- fix M3: solo se bloquea si el tenant NO permite continuas
  -- (config.reserva.permitir_continuas, default false). Antes se bloqueaba
  -- SIEMPRE, ignorando el toggle de AjustesReglas.
  v_permitir_continuas := COALESCE((v_tenant.config->'reserva'->>'permitir_continuas')::boolean, false);
  IF NOT v_permitir_continuas THEN
    SELECT EXISTS(
      SELECT 1 FROM reservas
      WHERE usuario_id = v_user_id
        AND status IN ('confirmada','completada')
        AND (slot_fin = v_slot_inicio OR slot_inicio = v_slot_fin)
    ) INTO v_existe_continua;
    IF v_existe_continua THEN
      RAISE EXCEPTION 'CONTINUA: No puedes reservar horas continuas';
    END IF;
  END IF;

  -- Cupo
  -- Cupo = PERSONAS: cada reserva ocupa 1 + sus invitados. La nueva reserva suma
  -- 1 (el socio) + p_invitados.
  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada','completada');

  IF v_cupos_ocupados + 1 + p_invitados > v_clase.cupo_max THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_clase.cupo_max;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

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

  -- ───────────────────────────────────────────────────────────────────────
  -- Débito de crédito (solo socios con tier creditos/hibrido). Atómico con
  -- el INSERT de la reserva: si algo arriba abortó, esto nunca corrió.
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - 1
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -1,
      v_reserva_id, 'reserva ' || v_folio_nuevo, v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', p_clase_id,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

CREATE OR REPLACE FUNCTION expandir_clases(
  p_sucursal_id uuid,
  p_desde date,
  p_hasta date
)
RETURNS TABLE (
  clase_id uuid,
  horario_recurrente_id uuid,
  fecha date,
  hora_inicio time,
  duracion_minutos integer,
  recurso_id uuid,
  sucursal_id uuid,
  nombre text,
  disciplina text,
  descripcion text,
  cupo_max integer,
  instructor_id uuid,
  instructor_nombre text,
  status text,
  reservados integer,
  recurso_nombre text,
  recurso_foto_url text,
  recurso_tiers_permitidos text[],
  instructor_foto_url text,
  instructor_bio text,
  sucursal_timezone text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH params AS (
    SELECT
      get_my_tenant_id() AS tenant_id,
      p_desde AS desde,
      LEAST(p_hasta, (p_desde + interval '92 days')::date) AS hasta,
      (SELECT config->>'timezone' FROM tenants WHERE id = get_my_tenant_id()) AS tenant_tz
  ),
  virtuales AS (
    SELECT
      hr.id            AS horario_id,
      hr.sucursal_id   AS sucursal_id,
      hr.recurso_id    AS recurso_id,
      gs::date         AS fecha,
      hr.hora_inicio   AS hora_inicio,
      hr.duracion_minutos AS duracion_minutos,
      hr.nombre        AS nombre,
      (r.tipo_contenido)[1] AS disciplina,
      COALESCE(hr.cupo_max, r.cupo_max_default) AS cupo_max,
      hr.instructor_id AS instructor_id,
      r.nombre         AS recurso_nombre,
      r.foto_url       AS recurso_foto_url,
      r.tiers_permitidos AS recurso_tiers_permitidos,
      COALESCE(NULLIF(s.timezone, ''), pa.tenant_tz, 'America/Mexico_City') AS sucursal_timezone
    FROM params pa
    JOIN horarios_recurrentes hr
      ON hr.tenant_id = pa.tenant_id
     AND (p_sucursal_id IS NULL OR hr.sucursal_id = p_sucursal_id)
     AND hr.activo
    JOIN recursos r ON r.id = hr.recurso_id AND r.activo
    JOIN sucursales s ON s.id = hr.sucursal_id
    CROSS JOIN LATERAL generate_series(pa.desde::timestamp, pa.hasta::timestamp, '1 day'::interval) AS gs
    WHERE EXTRACT(DOW FROM gs)::int = ANY(hr.dias_semana)
  )
  -- 1) Instancias de regla: virtual + su materializada (override/reserva) si existe.
  SELECT
    c.id AS clase_id,
    v.horario_id AS horario_recurrente_id,
    v.fecha,
    v.hora_inicio,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.duracion_minutos ELSE v.duracion_minutos END,
    v.recurso_id,
    v.sucursal_id,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.nombre ELSE v.nombre END,
    v.disciplina,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.descripcion ELSE NULL END,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.cupo_max ELSE v.cupo_max END,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.instructor_id ELSE v.instructor_id END,
    i.nombre,
    COALESCE(c.status, 'programada'),
    COALESCE(res.reservados, 0),
    v.recurso_nombre,
    v.recurso_foto_url,
    v.recurso_tiers_permitidos,
    i.foto_url,
    i.bio,
    v.sucursal_timezone
  FROM virtuales v
  LEFT JOIN clases c
    ON c.horario_recurrente_id = v.horario_id AND c.fecha = v.fecha
  LEFT JOIN instructores i
    ON i.id = CASE WHEN c.origen = 'recurrente_modificada' THEN c.instructor_id ELSE v.instructor_id END
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(1 + invitados_count), 0)::int AS reservados
    FROM reservas
    WHERE clase_id = c.id AND status IN ('confirmada', 'completada')
  ) res ON c.id IS NOT NULL

  UNION ALL

  -- 2) Clases ad-hoc ('manual') y legacy sin regla.
  SELECT
    c.id,
    NULL::uuid,
    c.fecha,
    c.hora_inicio,
    c.duracion_minutos,
    c.recurso_id,
    c.sucursal_id,
    c.nombre,
    c.disciplina,
    c.descripcion,
    c.cupo_max,
    c.instructor_id,
    i.nombre,
    c.status,
    COALESCE((
      SELECT COALESCE(SUM(1 + invitados_count), 0)::int FROM reservas
      WHERE clase_id = c.id AND status IN ('confirmada', 'completada')
    ), 0),
    r.nombre,
    r.foto_url,
    r.tiers_permitidos,
    i.foto_url,
    i.bio,
    COALESCE(NULLIF(s.timezone, ''), pa.tenant_tz, 'America/Mexico_City')
  FROM params pa
  JOIN clases c
    ON c.tenant_id = pa.tenant_id
   AND (p_sucursal_id IS NULL OR c.sucursal_id = p_sucursal_id)
   AND c.horario_recurrente_id IS NULL
   AND c.fecha BETWEEN pa.desde AND pa.hasta
  JOIN recursos r ON r.id = c.recurso_id
  JOIN sucursales s ON s.id = c.sucursal_id
  LEFT JOIN instructores i ON i.id = c.instructor_id;
$$;

REVOKE ALL ON FUNCTION expandir_clases(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expandir_clases(uuid, date, date) TO authenticated;
REVOKE ALL ON FUNCTION reservar_clase_atomic(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reservar_clase_atomic(uuid, integer, text) TO authenticated;

-- ============================================================================
-- TEST (smoke) — el gate y la expansión cuentan personas (1 + invitados).
-- ============================================================================
DO $$
DECLARE v_gate text; v_exp text;
BEGIN
  SELECT pg_get_functiondef('reservar_clase_atomic(uuid, integer, text)'::regprocedure) INTO v_gate;
  IF position('v_cupos_ocupados + 1 + p_invitados' in v_gate) = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: el gate no cuenta invitados en el cupo.';
  END IF;
  SELECT pg_get_functiondef('expandir_clases(uuid, date, date)'::regprocedure) INTO v_exp;
  IF position('SUM(1 + invitados_count)' in v_exp) = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: expandir_clases no cuenta invitados en reservados.';
  END IF;
  RAISE NOTICE 'TEST OK: cupo = personas (gate + expandir cuentan 1 + invitados).';
END $$;
