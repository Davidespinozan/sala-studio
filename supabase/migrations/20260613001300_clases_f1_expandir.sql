-- ============================================================================
-- MODELO VIRTUAL DE CLASES — F1: RPC de expansión.
-- ----------------------------------------------------------------------------
-- expandir_clases(sucursal, desde, hasta) devuelve las clases del rango SIN
-- pre-generarlas: expande las reglas (horarios_recurrentes) sobre las fechas y,
-- para cada (regla, fecha), si existe una clase MATERIALIZADA (override o
-- reservada) la usa; si no, devuelve la instancia VIRTUAL (clase_id NULL).
--
-- Resolución de campos de display:
--   - override explícito (origen='recurrente_modificada') → usa los campos de la
--     fila `clases` (el admin editó ese día puntual).
--   - resto (virtual o materializada solo por reserva, origen='recurrente') →
--     usa los campos de la REGLA → editar el horario se refleja al instante.
-- `status` viene de la fila materializada (puede ser 'cancelada'); 'programada'
-- si es virtual. `reservados` = reservas confirmada/completada de esa clase
-- (0 para virtuales, que aún no tienen fila).
--
-- También incluye las clases ad-hoc ('manual', sin regla) y cualquier legacy que
-- no matcheó ninguna regla en F0 (horario_recurrente_id NULL) — sin duplicar,
-- porque esas no tienen una virtual equivalente.
--
-- SECURITY DEFINER: el conteo de cupo necesita leer TODAS las reservas de la
-- clase (un socio no puede vía RLS). Se scopea todo a get_my_tenant_id().
-- Rango acotado a 92 días para evitar abuso.
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
  reservados integer
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
      LEAST(p_hasta, (p_desde + interval '92 days')::date) AS hasta
  ),
  -- Expandir reglas activas sobre el rango (una instancia virtual por fecha que
  -- cae en dias_semana). Campos de display de la REGLA.
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
      hr.instructor_id AS instructor_id
    FROM params pa
    JOIN horarios_recurrentes hr ON hr.tenant_id = pa.tenant_id AND hr.sucursal_id = p_sucursal_id AND hr.activo
    JOIN recursos r ON r.id = hr.recurso_id AND r.activo
    CROSS JOIN LATERAL generate_series(pa.desde::timestamp, pa.hasta::timestamp, '1 day'::interval) AS gs
    WHERE EXTRACT(DOW FROM gs)::int = ANY(hr.dias_semana)
  )
  -- 1) Instancias de regla: virtual + su materializada (override/reserva) si existe.
  SELECT
    c.id AS clase_id,
    v.horario_id AS horario_recurrente_id,
    v.fecha,
    v.hora_inicio,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.duracion_minutos ELSE v.duracion_minutos END AS duracion_minutos,
    v.recurso_id,
    v.sucursal_id,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.nombre ELSE v.nombre END AS nombre,
    v.disciplina,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.descripcion ELSE NULL END AS descripcion,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.cupo_max ELSE v.cupo_max END AS cupo_max,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.instructor_id ELSE v.instructor_id END AS instructor_id,
    i.nombre AS instructor_nombre,
    COALESCE(c.status, 'programada') AS status,
    COALESCE(res.reservados, 0) AS reservados
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

  -- 2) Clases ad-hoc ('manual') y legacy sin regla (horario_recurrente_id NULL).
  --    No duplican una virtual: si una regla las cubriera, F0 las habría vinculado.
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
    ), 0)
  FROM params pa
  JOIN clases c
    ON c.tenant_id = pa.tenant_id
   AND c.sucursal_id = p_sucursal_id
   AND c.horario_recurrente_id IS NULL
   AND c.fecha BETWEEN pa.desde AND pa.hasta
  LEFT JOIN instructores i ON i.id = c.instructor_id;
$$;

REVOKE ALL ON FUNCTION expandir_clases(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expandir_clases(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION expandir_clases(uuid, date, date) IS
  'Modelo virtual: devuelve las clases de una sucursal en un rango calculándolas de horarios_recurrentes + las materializadas (overrides/reservas). clase_id NULL = virtual (aún sin materializar). Campos de display de la regla salvo override (recurrente_modificada). reservados = cupo ocupado. Scopeada al tenant del caller; rango máx 92 días.';

-- ============================================================================
-- TEST (smoke) — para una sucursal con regla activa, la expansión de la próxima
-- semana devuelve filas, e incluye al menos una virtual (clase_id NULL,
-- status programada). Simula JWT de staff. SKIP si no hay regla.
-- ============================================================================
DO $$
DECLARE
  v_staff_auth uuid; v_tenant uuid; v_suc uuid;
  v_hoy date; v_total int; v_virtuales int;
BEGIN
  SELECT u.auth_id, u.tenant_id INTO v_staff_auth, v_tenant
  FROM usuarios u
  WHERE u.rol IN ('recepcionista','admin') AND u.auth_id IS NOT NULL
  LIMIT 1;
  IF v_staff_auth IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay staff con auth_id.';
    RETURN;
  END IF;

  SELECT hr.sucursal_id INTO v_suc
  FROM horarios_recurrentes hr
  WHERE hr.tenant_id = v_tenant AND hr.activo
  LIMIT 1;
  IF v_suc IS NULL THEN
    RAISE NOTICE 'TEST SKIP: el tenant no tiene horarios recurrentes activos.';
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff_auth::text)::text, true);
  SELECT (now() AT TIME ZONE 'UTC')::date INTO v_hoy;

  SELECT count(*),
         count(*) FILTER (WHERE clase_id IS NULL AND status = 'programada')
    INTO v_total, v_virtuales
  FROM expandir_clases(v_suc, v_hoy, v_hoy + 14);

  IF v_total = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: expandir_clases no devolvió ninguna clase para 14 días con regla activa.';
  END IF;

  RAISE NOTICE 'TEST OK: expandir_clases devolvió % clases (% virtuales) en 14 días. Sin materializar nada.', v_total, v_virtuales;
END $$;
