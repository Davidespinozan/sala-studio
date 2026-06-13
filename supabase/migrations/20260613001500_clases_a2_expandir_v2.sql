-- ============================================================================
-- MODELO VIRTUAL DE CLASES — A2.0: expandir_clases v2 (display completo).
-- ----------------------------------------------------------------------------
-- Extiende F1 para que una sola llamada alcance a renderizar la UI del socio y
-- del admin sin joins extra:
--   - p_sucursal_id ahora es OPCIONAL (NULL = todas las sucursales del tenant).
--     La app del socio muestra todas; el admin pasa una sucursal puntual.
--   - Agrega campos de recurso (nombre, foto, tiers), instructor (foto, bio) y
--     la timezone de la sucursal (para calcular el instante real en el cliente).
-- Resto idéntico a F1: virtuales de las reglas + materializadas con overrides,
-- reservados, scopeada al tenant, rango máx 92 días.
-- ============================================================================

DROP FUNCTION IF EXISTS expandir_clases(uuid, date, date);

CREATE FUNCTION expandir_clases(
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
    SELECT count(*)::int AS reservados
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
      SELECT count(*)::int FROM reservas
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

COMMENT ON FUNCTION expandir_clases(uuid, date, date) IS
  'Modelo virtual v2: clases de un rango (sucursal NULL = todas las del tenant) desde horarios_recurrentes + materializadas (overrides/reservas), con recurso/instructor/tz para render directo. clase_id NULL = virtual. Scopeada al tenant; rango máx 92 días.';

-- ============================================================================
-- TEST (smoke) — devuelve filas con sucursal NULL (todas) y trae recurso_nombre.
-- ============================================================================
DO $$
DECLARE
  v_staff_auth uuid; v_tenant uuid; v_hoy date; v_total int; v_con_sala int;
BEGIN
  SELECT auth_id, tenant_id INTO v_staff_auth, v_tenant
  FROM usuarios WHERE rol IN ('recepcionista','admin') AND auth_id IS NOT NULL LIMIT 1;
  IF v_staff_auth IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay staff con auth_id.'; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM horarios_recurrentes WHERE tenant_id = v_tenant AND activo) THEN
    RAISE NOTICE 'TEST SKIP: no hay horarios recurrentes activos.'; RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff_auth::text)::text, true);
  SELECT (now() AT TIME ZONE 'UTC')::date INTO v_hoy;

  SELECT count(*), count(*) FILTER (WHERE recurso_nombre IS NOT NULL)
    INTO v_total, v_con_sala
  FROM expandir_clases(NULL, v_hoy, v_hoy + 14);

  IF v_total = 0 OR v_con_sala = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: expandir_clases v2 devolvió % filas (% con sala).', v_total, v_con_sala;
  END IF;

  RAISE NOTICE 'TEST OK: expandir_clases v2 (sucursal NULL=todas) devolvió % clases con datos de sala.', v_total;
END $$;
