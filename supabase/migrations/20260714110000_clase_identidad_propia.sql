-- ============================================================================
-- UNA SALA, MUCHAS CLASES — la clase gana identidad propia
-- ----------------------------------------------------------------------------
-- Caso real (gym con UNA sola sala y un programa distinto cada día):
--   Lunes/Jueves  Fuerza Inferior   · Piernas + Cardio HIIT
--   Martes/Viernes Fuerza Superior  · Tren superior + Cardio HIIT
--   Miércoles     Full Body         · Cuerpo completo
--   Sábado        Fuerza Total      · Fuerza + Cardio HIIT
--
-- El modelo asumía "una sala = una disciplina": la clase HEREDABA de la sala su
-- foto y su disciplina, y no tenía dónde guardar el "enfoque". Consecuencias:
--   · todas las clases del socio salían con LA MISMA FOTO (la de la sala);
--   · todas figuraban con la misma disciplina (la de la sala);
--   · "Piernas + Cardio HIIT" no tenía dónde vivir → el socio veía solo el nombre.
--
-- Ahora el HORARIO RECURRENTE (que es lo que define "qué se hace tal día") lleva
-- su propia descripción, disciplina y foto. La sala sigue siendo el fallback: un
-- gym con varias salas no cambia en nada.
--
-- El cupo ya era por horario (NULL = el default de la sala), así que un cupo
-- distinto el fin de semana ya se resolvía con un horario aparte.
-- ============================================================================

-- ── 1) El horario define la clase ───────────────────────────────────────────
ALTER TABLE horarios_recurrentes
  ADD COLUMN IF NOT EXISTS descripcion text,
  ADD COLUMN IF NOT EXISTS disciplina text,
  ADD COLUMN IF NOT EXISTS foto_url text;

COMMENT ON COLUMN horarios_recurrentes.descripcion IS
  'Enfoque de la clase ("Piernas + Cardio HIIT"). Es lo que distingue una clase de otra cuando comparten sala.';
COMMENT ON COLUMN horarios_recurrentes.disciplina IS
  'Disciplina de ESTA clase. NULL → cae a la de la sala (recursos.tipo_contenido[1]).';
COMMENT ON COLUMN horarios_recurrentes.foto_url IS
  'Foto de ESTA clase. NULL → cae a la de la sala. Sin esto, un gym de una sola sala mostraba la misma imagen en todas sus clases.';

-- ── 2) Una clase puntual puede pisar la foto (día especial) ─────────────────
ALTER TABLE clases
  ADD COLUMN IF NOT EXISTS foto_url text;

COMMENT ON COLUMN clases.foto_url IS
  'Foto de esta instancia puntual. NULL → cae a la del horario, y luego a la de la sala.';

-- ── 3) Materializar hereda del HORARIO, no de la sala ───────────────────────
CREATE OR REPLACE FUNCTION materializar_clase(
  p_horario_id uuid,
  p_fecha date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_clase_id uuid;
BEGIN
  -- ¿Ya existe la instancia de ese horario en esa fecha?
  SELECT id INTO v_clase_id
  FROM clases
  WHERE horario_recurrente_id = p_horario_id
    AND fecha = p_fecha
    AND tenant_id = v_tenant;

  IF v_clase_id IS NOT NULL THEN
    RETURN v_clase_id;
  END IF;

  INSERT INTO clases (
    tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos,
    nombre, disciplina, descripcion, foto_url,
    cupo_max, instructor_id, origen, horario_recurrente_id, status
  )
  SELECT
    hr.tenant_id, hr.sucursal_id, hr.recurso_id, p_fecha, hr.hora_inicio, hr.duracion_minutos,
    hr.nombre,
    -- La disciplina/foto de la CLASE mandan; la sala es el fallback.
    COALESCE(hr.disciplina, (r.tipo_contenido)[1]),
    hr.descripcion,
    hr.foto_url,
    COALESCE(hr.cupo_max, r.cupo_max_default),
    hr.instructor_id, 'recurrente', hr.id, 'programada'
  FROM horarios_recurrentes hr
  JOIN recursos   r ON r.id = hr.recurso_id
  JOIN sucursales s ON s.id = hr.sucursal_id
  WHERE hr.id = p_horario_id
    AND hr.tenant_id = v_tenant
    AND hr.activo
    AND r.activo
  RETURNING id INTO v_clase_id;

  IF v_clase_id IS NULL THEN
    RAISE EXCEPTION 'HORARIO_NO_EXISTE: El horario no existe, no está activo, o su sala está inactiva';
  END IF;

  RETURN v_clase_id;
END;
$$;

REVOKE ALL ON FUNCTION materializar_clase(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION materializar_clase(uuid, date) TO authenticated;

-- ── 4) expandir_clases devuelve la identidad de la CLASE ────────────────────
-- Cambia la forma de la tabla (columna nueva clase_foto_url) → hay que dropear.
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
  -- Imagen EFECTIVA de la clase: la suya → la del horario → la de la sala.
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
      -- La clase manda; la sala es el fallback.
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
    -- El enfoque sale del horario; una clase modificada puede pisarlo.
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

-- ── 5) La landing pública necesita leer el programa ─────────────────────────
-- Un visitante (anon, sin JWT) no podía leer horarios_recurrentes, así que la
-- landing no tenía forma de mostrar el programa de la semana. Solo lectura, solo
-- horarios ACTIVOS: es información pública por definición (el horario del gym).
DROP POLICY IF EXISTS horarios_rec_read_public ON horarios_recurrentes;
CREATE POLICY horarios_rec_read_public ON horarios_recurrentes
  FOR SELECT
  TO anon
  USING (activo);

-- ============================================================================
-- SELF-TEST — devuelve TABLA.
-- ============================================================================
WITH checks AS (
  SELECT 'horarios_recurrentes.descripcion (enfoque)' AS prueba,
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'horarios_recurrentes' AND column_name = 'descripcion') AS ok
  UNION ALL
  SELECT 'horarios_recurrentes.disciplina',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'horarios_recurrentes' AND column_name = 'disciplina')
  UNION ALL
  SELECT 'horarios_recurrentes.foto_url (imagen propia de la clase)',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'horarios_recurrentes' AND column_name = 'foto_url')
  UNION ALL
  SELECT 'clases.foto_url',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'clases' AND column_name = 'foto_url')
  UNION ALL
  SELECT 'expandir_clases devuelve clase_foto_url',
         EXISTS (SELECT 1 FROM information_schema.routines r
                 JOIN information_schema.parameters p ON p.specific_name = r.specific_name
                 WHERE r.routine_name = 'expandir_clases' AND p.parameter_name = 'clase_foto_url')
  UNION ALL
  SELECT 'materializar_clase hereda la disciplina del horario',
         (SELECT pg_get_functiondef(oid) LIKE '%COALESCE(hr.disciplina%'
            FROM pg_proc WHERE proname = 'materializar_clase' LIMIT 1)
  UNION ALL
  SELECT 'la landing (anon) puede leer los horarios activos',
         EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename = 'horarios_recurrentes'
                   AND policyname = 'horarios_rec_read_public')
)
SELECT CASE WHEN ok THEN '✅' ELSE '❌' END AS estado, prueba
FROM checks
ORDER BY ok, prueba;
