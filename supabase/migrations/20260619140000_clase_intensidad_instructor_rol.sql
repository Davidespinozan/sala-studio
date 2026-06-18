-- ============================================================================
-- DETALLE DE CLASE más rico: INTENSIDAD (del recurso/disciplina) + ROL del
-- instructor. Ambos editables desde admin (Recursos / Instructores).
-- ----------------------------------------------------------------------------
-- Diseño: la intensidad es una propiedad de la SALA/DISCIPLINA (igual que la
-- disciplina, que ya sale de recursos.tipo_contenido[1]); el rol es del
-- instructor ("Coach de cycling", etc.). Por eso:
--   1) recursos    += intensidad text   (baja | media | alta, o libre)
--   2) instructores += rol text
--   3) expandir_clases v2 → v3: agrega intensidad + instructor_rol al final
--      del RETURNS TABLE (no mueve columnas existentes → bajo riesgo).
-- No se tocan `clases` ni `horarios_recurrentes` (el modelo virtual queda igual).
-- ============================================================================

ALTER TABLE recursos     ADD COLUMN IF NOT EXISTS intensidad text;
ALTER TABLE instructores ADD COLUMN IF NOT EXISTS rol text;

COMMENT ON COLUMN recursos.intensidad IS
  'Intensidad de la disciplina de esta sala (baja|media|alta o libre). Editable en admin → Recursos. La muestra el Detalle de clase del socio.';
COMMENT ON COLUMN instructores.rol IS
  'Rol/título del instructor (ej. "Coach de cycling"). Editable en admin → Instructores. Lo muestra el Detalle de clase.';

-- ----------------------------------------------------------------------------
-- expandir_clases v3 — idéntica a v2 + 2 columnas al final: intensidad,
-- instructor_rol. (Re-creada completa porque hay que cambiar la firma RETURNS.)
-- ----------------------------------------------------------------------------
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
  sucursal_timezone text,
  intensidad text,
  instructor_rol text
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
      r.intensidad     AS intensidad,
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
    v.sucursal_timezone,
    v.intensidad,
    i.rol
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
    COALESCE(NULLIF(s.timezone, ''), pa.tenant_tz, 'America/Mexico_City'),
    r.intensidad,
    i.rol
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
  'Modelo virtual v3: igual que v2 + intensidad (del recurso) e instructor_rol al final. clase_id NULL = virtual. Scopeada al tenant; rango máx 92 días.';

-- ----------------------------------------------------------------------------
-- DEMO (healthyspace): sembrar intensidad por disciplina y un rol por
-- instructor, para que el Detalle de clase muestre la feature. Solo rellena
-- lo que esté NULL → no pisa nada que ya hayas configurado.
-- ----------------------------------------------------------------------------
UPDATE recursos r
SET intensidad = CASE
  WHEN r.nombre ILIKE '%cycling%' OR r.nombre ILIKE '%endurance%'
    OR r.nombre ILIKE '%hiit%'    OR r.nombre ILIKE '%spinning%' THEN 'alta'
  WHEN r.nombre ILIKE '%yoga%'    OR r.nombre ILIKE '%pilates%'
    OR r.nombre ILIKE '%reformer%' OR r.nombre ILIKE '%stretch%'
    OR r.nombre ILIKE '%movilidad%' THEN 'baja'
  ELSE 'media'
END
WHERE r.tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace')
  AND r.intensidad IS NULL;

UPDATE instructores i
SET rol = CASE
  WHEN array_length(i.especialidades, 1) >= 1
    THEN 'Coach de ' || lower(i.especialidades[1])
  ELSE 'Coach certificado'
END
WHERE i.tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace')
  AND i.rol IS NULL;
