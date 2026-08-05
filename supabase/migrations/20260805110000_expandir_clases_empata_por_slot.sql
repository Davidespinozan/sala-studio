-- ── Fix de fondo: expandir_clases empata la clase materializada por SLOT ──────
-- Problema: la rama 1 empataba la clase con el hueco virtual por
-- `c.horario_recurrente_id = v.horario_id`. Si editas/borras un horario (queda
-- otro id activo en ese slot), la clase materializada se "huérfana" y no empata
-- → la lista la muestra como virtual sin reservas, y las reservas encima no se
-- pueden cancelar. (El materializar_clase ya adopta por slot; esto hace lo mismo
-- en la LECTURA.)
--
-- Cambio QUIRÚRGICO: SOLO se cambia el join de la clase en la rama 1, de
-- horario_id a un LATERAL por slot (recurso+hora+fecha) que elige UNA clase por
-- hueco (prefiere la NO cancelada). Todo lo demás —columnas, CASE de override,
-- rama 2 (manuales), conteo de reservados— queda IDÉNTICO. Es reversible (basta
-- volver a poner el join por horario_id).

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
  clase_foto_url text,
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
      COALESCE(hr.disciplina, (r.tipo_contenido)[1]) AS disciplina,
      hr.descripcion   AS descripcion,
      COALESCE(hr.foto_url, r.foto_url) AS clase_foto_url,
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
    COALESCE(c.disciplina, v.disciplina),
    COALESCE(c.descripcion, v.descripcion),
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.cupo_max ELSE v.cupo_max END,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.instructor_id ELSE v.instructor_id END,
    i.nombre,
    COALESCE(c.status, 'programada'),
    COALESCE(res.reservados, 0),
    v.recurso_nombre,
    v.recurso_foto_url,
    COALESCE(c.foto_url, v.clase_foto_url),
    v.recurso_tiers_permitidos,
    i.foto_url,
    i.bio,
    v.sucursal_timezone
  FROM virtuales v
  -- Empate por SLOT (no por horario_id): elige UNA clase del hueco, prefiriendo
  -- la NO cancelada. Solo clases de regla (horario_recurrente_id NOT NULL); las
  -- 'manual' (horario NULL) viven en la rama 2.
  LEFT JOIN LATERAL (
    SELECT cc.*
    FROM clases cc
    WHERE cc.recurso_id = v.recurso_id
      AND cc.hora_inicio = v.hora_inicio
      AND cc.fecha = v.fecha
      AND cc.horario_recurrente_id IS NOT NULL
    ORDER BY (cc.status = 'cancelada'), cc.created_at DESC
    LIMIT 1
  ) c ON true
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
    COALESCE(c.foto_url, r.foto_url),
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

-- Self-test (tabla): la rama 1 ya empata por slot (LATERAL recurso+hora).
SELECT
  (position('cc.recurso_id = v.recurso_id' in p.prosrc) > 0) AS empata_por_slot,
  (position('cc.horario_recurrente_id IS NOT NULL' in p.prosrc) > 0) AS respeta_manuales
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'expandir_clases';