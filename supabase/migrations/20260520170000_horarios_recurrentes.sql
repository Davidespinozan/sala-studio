-- ============================================================================
-- S5 — Horarios recurrentes definibles por el admin
-- ============================================================================
-- Hoy generar_clases_recurrentes() lee recursos.horarios (jsonb del seed). Este
-- sprint mueve la definición de horarios a una tabla que el admin gestiona, y
-- reescribe el generador para leerla.
--
-- DECISIÓN — vínculo clase → horario: se agrega `clases.horario_recurrente_id`
-- (FK real) en vez de reusar `clases.serie_id`. Razones:
--   - serie_id es un hash determinístico por (recurso, UN día, hora). Un
--     horario_recurrente cubre VARIOS días (dias_semana int[]), así que no
--     mapea a un solo serie_id.
--   - Un FK real permite integridad referencial, "ver/cancelar las clases de
--     este horario", y ON DELETE SET NULL si el horario se borra.
-- serie_id se deja intacto: las clases viejas lo conservan; las nuevas lo
-- dejan NULL y usan horario_recurrente_id.
--
-- CONVIVENCIA con las clases viejas (las ~310 ya generadas):
--   - Las viejas quedan con horario_recurrente_id = NULL (y su serie_id viejo).
--     Siguen existiendo y funcionando — esta migración nunca borra clases.
--   - El generador nuevo solo INSERTA (ON CONFLICT DO NOTHING). Donde una clase
--     vieja ya ocupa un slot, la nueva generación lo saltea y la vieja queda
--     sin vincular. Al envejecer las viejas hacia el pasado, las clases futuras
--     pasan a estar 100% vinculadas a horarios_recurrentes.
-- ============================================================================

-- ============================================================================
-- A) TABLA horarios_recurrentes
-- ============================================================================

CREATE TABLE IF NOT EXISTS horarios_recurrentes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recurso_id uuid NOT NULL REFERENCES recursos(id) ON DELETE CASCADE,

  -- Días de la semana en que se repite. 0=domingo .. 6=sábado (= EXTRACT DOW).
  dias_semana integer[] NOT NULL,

  hora_inicio time NOT NULL,
  duracion_minutos integer NOT NULL DEFAULT 60 CHECK (duracion_minutos > 0),
  nombre text NOT NULL,

  instructor_id uuid REFERENCES instructores(id) ON DELETE SET NULL,
  -- NULL → la generación usa recursos.cupo_max_default.
  cupo_max integer CHECK (cupo_max IS NULL OR cupo_max > 0),

  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- dias_semana debe ser no vacío y solo contener 0..6.
  CHECK (cardinality(dias_semana) >= 1),
  CHECK (dias_semana <@ ARRAY[0, 1, 2, 3, 4, 5, 6])
);

CREATE INDEX IF NOT EXISTS idx_horarios_rec_tenant ON horarios_recurrentes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_horarios_rec_recurso ON horarios_recurrentes (recurso_id);

DROP TRIGGER IF EXISTS horarios_recurrentes_set_updated_at ON horarios_recurrentes;
CREATE TRIGGER horarios_recurrentes_set_updated_at
  BEFORE UPDATE ON horarios_recurrentes
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE horarios_recurrentes ENABLE ROW LEVEL SECURITY;

-- RLS — patrón consistente con recursos/clases: lectura por tenant, gestión admin.
DROP POLICY IF EXISTS horarios_rec_read_tenant ON horarios_recurrentes;
CREATE POLICY horarios_rec_read_tenant ON horarios_recurrentes
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id());

DROP POLICY IF EXISTS horarios_rec_admin_all ON horarios_recurrentes;
CREATE POLICY horarios_rec_admin_all ON horarios_recurrentes
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

COMMENT ON TABLE horarios_recurrentes IS
  'S5: reglas de horario recurrente por sala que el admin define. generar_clases_recurrentes() las lee para crear las clases concretas.';
COMMENT ON COLUMN horarios_recurrentes.dias_semana IS
  'Días en que se repite: 0=domingo .. 6=sábado, alineado con EXTRACT(DOW).';
COMMENT ON COLUMN horarios_recurrentes.cupo_max IS
  'Override de cupo. NULL → la generación usa recursos.cupo_max_default.';

-- ============================================================================
-- B) clases.horario_recurrente_id — vínculo clase → horario
-- ============================================================================

ALTER TABLE clases
  ADD COLUMN IF NOT EXISTS horario_recurrente_id uuid
    REFERENCES horarios_recurrentes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clases_horario_recurrente
  ON clases (horario_recurrente_id)
  WHERE horario_recurrente_id IS NOT NULL;

COMMENT ON COLUMN clases.horario_recurrente_id IS
  'S5: FK al horario recurrente que generó esta clase. NULL en las clases viejas (pre-S5) y en las creadas manualmente.';

-- ============================================================================
-- C) REESCRITURA de generar_clases_recurrentes
-- ============================================================================
-- Misma firma (uuid, integer) → el cron / Edge Function regenerar-clases siguen
-- funcionando sin cambios. Ahora la fuente es horarios_recurrentes (no
-- recursos.horarios). Idempotente vía ON CONFLICT DO NOTHING.
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

  -- S4.4: "hoy" en la timezone del tenant.
  SELECT COALESCE(config->>'timezone', 'America/Mexico_City')
    INTO v_tz
    FROM tenants
    WHERE id = p_tenant_id;

  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'Tenant % no existe', p_tenant_id;
  END IF;

  v_hoy := (now() AT TIME ZONE v_tz)::date;

  WITH fechas AS (
    SELECT generate_series(
      v_hoy,
      v_hoy + (p_dias_forward || ' days')::interval,
      '1 day'::interval
    )::date AS fecha
  )
  INSERT INTO clases (
    tenant_id, recurso_id, fecha, hora_inicio, duracion_minutos,
    nombre, disciplina, cupo_max, instructor_id, origen,
    horario_recurrente_id, status
  )
  SELECT
    hr.tenant_id,
    hr.recurso_id,
    f.fecha,
    hr.hora_inicio,
    hr.duracion_minutos,
    hr.nombre,
    r.tipo_contenido[1],
    COALESCE(hr.cupo_max, r.cupo_max_default),
    hr.instructor_id,
    'recurrente',
    hr.id,
    'programada'
  FROM horarios_recurrentes hr
  JOIN recursos r ON r.id = hr.recurso_id
  CROSS JOIN fechas f
  WHERE hr.tenant_id = p_tenant_id
    AND hr.activo = true
    AND r.activo = true
    AND EXTRACT(DOW FROM f.fecha)::int = ANY(hr.dias_semana)
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

COMMENT ON FUNCTION generar_clases_recurrentes(uuid, integer) IS
  'S5: genera clases concretas desde horarios_recurrentes (reglas del admin). "Hoy" en la tz del tenant. Idempotente (ON CONFLICT DO NOTHING). Llamada por la Edge Function regenerar-clases (cron nightly).';

-- El generador base no debe ser invocable por clientes (evita generación
-- cross-tenant pasando otro p_tenant_id). El cron usa service_role.
REVOKE ALL ON FUNCTION generar_clases_recurrentes(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generar_clases_recurrentes(uuid, integer) TO service_role;

-- ============================================================================
-- D) generar_mis_clases_recurrentes — wrapper para el botón "generar ahora"
-- ============================================================================
-- El admin lo invoca desde la UI. Resuelve su propio tenant y exige rol admin,
-- así no se puede generar en otro tenant.
-- ============================================================================

CREATE OR REPLACE FUNCTION generar_mis_clases_recurrentes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  v_tenant_id := get_my_tenant_id();
  IF v_tenant_id IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo un administrador puede generar clases';
  END IF;
  RETURN generar_clases_recurrentes(v_tenant_id, 60);
END $$;

GRANT EXECUTE ON FUNCTION generar_mis_clases_recurrentes() TO authenticated;

COMMENT ON FUNCTION generar_mis_clases_recurrentes() IS
  'S5: genera las clases recurrentes (60 días) del tenant del admin actual. Wrapper scopeado de generar_clases_recurrentes para el botón "generar ahora".';

-- ============================================================================
-- E) SEED — convierte los recursos.horarios existentes en horarios_recurrentes
-- ============================================================================
-- Bootstrap: agrupa los bloques de recursos.horarios por (sala, hora) y arma
-- un horario_recurrente con dias_semana = el array de días. Así sala-demo
-- arranca con horarios visibles en el admin.
--
-- Idempotente: solo siembra tenants que aún no tengan ningún horario_recurrente
-- (re-correr la migración no duplica; un tenant que ya tiene horarios creados
-- por el admin no se toca).
-- ============================================================================

DO $$
DECLARE
  v_creados integer := 0;
BEGIN
  WITH bloques AS (
    SELECT
      r.tenant_id,
      r.id            AS recurso_id,
      r.nombre        AS recurso_nombre,
      r.tipo_contenido,
      CASE h->>'dia'
        WHEN 'domingo'   THEN 0
        WHEN 'lunes'     THEN 1
        WHEN 'martes'    THEN 2
        WHEN 'miercoles' THEN 3
        WHEN 'jueves'    THEN 4
        WHEN 'viernes'   THEN 5
        WHEN 'sabado'    THEN 6
      END             AS dia_int,
      (h->>'inicio')::time AS hora_inicio,
      (h->>'fin')::time    AS hora_fin
    FROM recursos r
    CROSS JOIN LATERAL jsonb_array_elements(r.horarios) h
    WHERE r.horarios IS NOT NULL
      AND jsonb_typeof(r.horarios) = 'array'
  )
  INSERT INTO horarios_recurrentes (
    tenant_id, recurso_id, dias_semana, hora_inicio, duracion_minutos,
    nombre, cupo_max, activo
  )
  SELECT
    b.tenant_id,
    b.recurso_id,
    array_agg(DISTINCT b.dia_int ORDER BY b.dia_int),
    b.hora_inicio,
    (EXTRACT(EPOCH FROM (b.hora_fin - b.hora_inicio)) / 60)::integer,
    CASE
      WHEN COALESCE(b.tipo_contenido[1], '') = '' THEN b.recurso_nombre
      WHEN position(lower(b.tipo_contenido[1]) IN lower(b.recurso_nombre)) > 0
        THEN b.recurso_nombre
      ELSE b.recurso_nombre || ' · ' || b.tipo_contenido[1]
    END,
    NULL,  -- cupo_max: usa el default de la sala
    true
  FROM bloques b
  WHERE b.dia_int IS NOT NULL
    AND b.hora_fin > b.hora_inicio
    AND NOT EXISTS (
      SELECT 1 FROM horarios_recurrentes hr WHERE hr.tenant_id = b.tenant_id
    )
  GROUP BY b.tenant_id, b.recurso_id, b.recurso_nombre, b.tipo_contenido,
           b.hora_inicio, b.hora_fin;

  GET DIAGNOSTICS v_creados = ROW_COUNT;
  RAISE NOTICE 'Seed horarios_recurrentes: % horarios creados desde recursos.horarios.', v_creados;
END $$;

-- ============================================================================
-- Fin migración S5
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migración horarios_recurrentes OK: tabla + clases.horario_recurrente_id + generador reescrito + seed.';
END $$;
