-- ============================================================================
-- S4.1 — Modelo de cupos real: tabla `clases` + cupo_max + reservas.clase_id
-- ============================================================================
-- Reemplaza el sistema mock (CUPO_MAX_MOCK=8 en claseAdapter.ts) por un modelo
-- de datos persistente.
--
-- Pasos:
--   A) CREATE TABLE clases (con índices, RLS y trigger updated_at)
--   B) ALTER recursos ADD cupo_max_default
--   C) ALTER reservas ADD clase_id (nullable; NOT NULL llegará en sprint futuro)
--   D) FUNCTION generar_clases_recurrentes(p_tenant_id, p_dias_forward)
--   E) Generación inicial: sala-demo, 60 días forward
--   F) Migración de reservas existentes en 3 pasos:
--      F1) UPDATE exact-match por (tenant, recurso, fecha, hora_inicio)
--      F2) INSERT clases sintéticas (origen='manual') para reservas huérfanas
--      F3) UPDATE para linkear las huérfanas a las sintéticas recién creadas
--   G) Verificación final: si quedan reservas (confirmada/completada/no_show)
--      sin clase_id, RAISE EXCEPTION → rollback automático.
--
-- Decisiones técnicas (ver report en commit):
--   - 1 clase por bloque (yoga lunes 07-09 → 1 clase a 7am de 120 min).
--   - Reservas mock con horas que no caen al inicio de bloque (8am, 19:00, 9am,
--     etc.) reciben clases sintéticas con origen='manual'.
--   - serie_id determinístico vía md5(recurso_id + dia + hora_inicio): el cron
--     nightly de S4.3 producirá la misma serie_id sin re-generar UUIDs.
--   - Timezone hardcodeada a 'America/Mexico_City' (matchea SET TIME ZONE del
--     seed sala-gym-data.sql). Si en el futuro el tenant configura su tz, este
--     valor debería leerse de tenants.config.
--
-- Idempotente: se puede correr N veces. ON CONFLICT DO NOTHING en INSERTs.
-- Rollback automático si la verificación final falla.
-- ============================================================================

-- ============================================================================
-- A) CREATE TABLE clases
-- ============================================================================

CREATE TABLE IF NOT EXISTS clases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recurso_id uuid NOT NULL REFERENCES recursos(id) ON DELETE CASCADE,

  -- Cuándo
  fecha date NOT NULL,
  hora_inicio time NOT NULL,
  duracion_minutos integer NOT NULL DEFAULT 60 CHECK (duracion_minutos > 0),

  -- Qué
  nombre text NOT NULL,
  disciplina text,
  descripcion text,

  -- Cuántos
  cupo_max integer NOT NULL CHECK (cupo_max > 0),

  -- Quién (mock-friendly hasta S6)
  instructor_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  instructor_nombre_mock text,

  -- Origen y agrupación
  origen text NOT NULL DEFAULT 'recurrente'
    CHECK (origen IN ('recurrente','manual','recurrente_modificada')),
  serie_id uuid,

  -- Estado
  status text NOT NULL DEFAULT 'programada'
    CHECK (status IN ('programada','cancelada','completada')),
  cancelada_at timestamptz,
  cancelada_motivo text,

  -- Metadata
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique parcial: no se pueden tener dos clases NO canceladas en el mismo slot.
CREATE UNIQUE INDEX IF NOT EXISTS clases_unique_slot
  ON clases (tenant_id, recurso_id, fecha, hora_inicio)
  WHERE status != 'cancelada';

CREATE INDEX IF NOT EXISTS idx_clases_tenant_fecha   ON clases (tenant_id, fecha);
CREATE INDEX IF NOT EXISTS idx_clases_recurso_fecha  ON clases (recurso_id, fecha);
CREATE INDEX IF NOT EXISTS idx_clases_serie          ON clases (serie_id) WHERE serie_id IS NOT NULL;

DROP TRIGGER IF EXISTS clases_set_updated_at ON clases;
CREATE TRIGGER clases_set_updated_at
  BEFORE UPDATE ON clases
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE clases ENABLE ROW LEVEL SECURITY;

-- Patrón consistente con recursos/tiers: read tenant + admin manage.
DROP POLICY IF EXISTS clases_read_tenant ON clases;
CREATE POLICY clases_read_tenant ON clases
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id());

DROP POLICY IF EXISTS clases_read_public ON clases;
CREATE POLICY clases_read_public ON clases
  FOR SELECT
  TO anon
  USING (status = 'programada');

DROP POLICY IF EXISTS clases_admin_all ON clases;
CREATE POLICY clases_admin_all ON clases
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

COMMENT ON TABLE clases IS
  'S4.1: cada fila es una instancia concreta de clase grupal en una sala a una fecha/hora. Generadas por recurrencia desde recursos.horarios o creadas manualmente por admin.';
COMMENT ON COLUMN clases.cupo_max IS
  'Override por instancia. Para clases generadas usa recursos.cupo_max_default; admin puede editar por instancia desde S4.3.';
COMMENT ON COLUMN clases.serie_id IS
  'Mismo UUID determinístico para todas las clases generadas del mismo bloque de horario. Permite "cancelar serie completa" en S4.3.';
COMMENT ON COLUMN clases.origen IS
  'recurrente=generada por cron; manual=creada por admin o sintética en migración S4.1; recurrente_modificada=admin editó override por instancia.';
COMMENT ON COLUMN clases.instructor_nombre_mock IS
  'Temporal mientras no exista tabla instructores (Sprint S6). Borrar columna cuando S6 reemplace por instructor_id NOT NULL.';

-- ============================================================================
-- B) ALTER TABLE recursos ADD cupo_max_default
-- ============================================================================

ALTER TABLE recursos
  ADD COLUMN IF NOT EXISTS cupo_max_default integer NOT NULL DEFAULT 12
    CHECK (cupo_max_default > 0);

COMMENT ON COLUMN recursos.cupo_max_default IS
  'Cupo por defecto que se usa al generar clases recurrentes. Cada clase puntual puede tener override en clases.cupo_max.';

-- Backfill: el DEFAULT 12 ya aplica a las filas existentes (Postgres lo aplica
-- inmediatamente en ADD COLUMN ... NOT NULL DEFAULT). No hace falta UPDATE.

-- ============================================================================
-- C) ALTER TABLE reservas ADD clase_id
-- ============================================================================

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS clase_id uuid REFERENCES clases(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_reservas_clase
  ON reservas (clase_id)
  WHERE clase_id IS NOT NULL;

COMMENT ON COLUMN reservas.clase_id IS
  'S4.1: FK a clases. NULL para reservas históricas pre-migración; NOT NULL llegará en sprint futuro tras un nuevo backfill.';

-- ============================================================================
-- D) FUNCTION generar_clases_recurrentes
-- ============================================================================
-- Parsea recursos.horarios (jsonb [{dia, inicio, fin}, ...]) e inserta UNA
-- clase por bloque para cada fecha en [today, today + p_dias_forward].
-- Idempotente: ON CONFLICT DO NOTHING en (tenant, recurso, fecha, hora_inicio).
-- Retorna jsonb con stats para observabilidad del cron de S4.3.
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
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id no puede ser NULL';
  END IF;
  IF p_dias_forward < 1 OR p_dias_forward > 365 THEN
    RAISE EXCEPTION 'p_dias_forward fuera de rango razonable [1, 365]: %', p_dias_forward;
  END IF;

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
    -- (Para soportar cross-midnight habría que generar 2 clases o aceptar fecha+1; out of scope S4.1.)
    SELECT *
    FROM bloques
    WHERE hora_fin_block > hora_inicio_block
  ),
  fechas AS (
    SELECT generate_series(
      CURRENT_DATE,
      CURRENT_DATE + (p_dias_forward || ' days')::interval,
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
    'dias_forward', p_dias_forward,
    'fecha_desde', CURRENT_DATE,
    'fecha_hasta', CURRENT_DATE + p_dias_forward,
    'ts', now()
  );
END $$;

COMMENT ON FUNCTION generar_clases_recurrentes(uuid, integer) IS
  'S4.1: genera clases instancia desde recursos.horarios. Idempotente. Usado por cron nightly (S4.3) y migración inicial.';

-- ============================================================================
-- E) Generación inicial para tenant sala-demo (60 días forward)
-- ============================================================================

DO $$
DECLARE
  v_tenant_id uuid;
  v_resultado jsonb;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'sala-demo';
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant sala-demo no existe; abortando migración';
  END IF;

  v_resultado := generar_clases_recurrentes(v_tenant_id, 60);
  RAISE NOTICE 'Generación recurrente: %', v_resultado;
END $$;

-- ============================================================================
-- F) Migración de reservas existentes (3 pasos)
-- ============================================================================
-- F1) UPDATE por slot exacto contra clases recién generadas.
-- F2) INSERT clases sintéticas (origen='manual') para reservas que NO matchearon
--     ningún bloque (típicamente reservas mock a las 8am/19:00/9am cuando los
--     bloques empiezan a horas diferentes). Una sola clase sintética por slot
--     distinto, aunque la cubran N reservas.
-- F3) UPDATE final para vincular reservas huérfanas con las sintéticas.
-- ============================================================================

DO $$
DECLARE
  v_pass1 integer := 0;
  v_pass2 integer := 0;
  v_pass3 integer := 0;
  v_orphans_final integer := 0;
  v_tz constant text := 'America/Mexico_City';
BEGIN
  -- F1: exact-match contra clases recurrentes generadas en E.
  UPDATE reservas r
  SET clase_id = c.id
  FROM clases c
  WHERE r.tenant_id = c.tenant_id
    AND r.recurso_id = c.recurso_id
    AND (r.slot_inicio AT TIME ZONE v_tz)::date = c.fecha
    AND (r.slot_inicio AT TIME ZONE v_tz)::time = c.hora_inicio
    AND r.clase_id IS NULL
    AND c.status != 'cancelada';
  GET DIAGNOSTICS v_pass1 = ROW_COUNT;
  RAISE NOTICE 'F1 exact match: % reservas linkeadas', v_pass1;

  -- F2: insertar clases sintéticas para reservas que aún no tienen clase_id.
  -- DISTINCT ON colapsa N reservas en el mismo slot a UNA sola clase sintética.
  INSERT INTO clases (
    tenant_id, recurso_id, fecha, hora_inicio, duracion_minutos,
    nombre, disciplina, cupo_max, origen, status
  )
  SELECT DISTINCT ON (
    r.tenant_id, r.recurso_id,
    (r.slot_inicio AT TIME ZONE v_tz)::date,
    (r.slot_inicio AT TIME ZONE v_tz)::time
  )
    r.tenant_id,
    r.recurso_id,
    (r.slot_inicio AT TIME ZONE v_tz)::date,
    (r.slot_inicio AT TIME ZONE v_tz)::time,
    r.duracion_min,
    CASE
      WHEN COALESCE(rec.tipo_contenido[1], '') = '' THEN
        rec.nombre
      WHEN position(lower(rec.tipo_contenido[1]) IN lower(rec.nombre)) > 0 THEN
        rec.nombre
      ELSE
        rec.nombre || ' · ' || rec.tipo_contenido[1]
    END,
    rec.tipo_contenido[1],
    rec.cupo_max_default,
    'manual',
    'programada'
  FROM reservas r
  JOIN recursos rec ON rec.id = r.recurso_id
  WHERE r.clase_id IS NULL
    AND r.status IN ('confirmada','completada','no_show')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_pass2 = ROW_COUNT;
  RAISE NOTICE 'F2 clases sintéticas creadas: %', v_pass2;

  -- F3: linkear las reservas huérfanas con las sintéticas recién creadas.
  UPDATE reservas r
  SET clase_id = c.id
  FROM clases c
  WHERE r.tenant_id = c.tenant_id
    AND r.recurso_id = c.recurso_id
    AND (r.slot_inicio AT TIME ZONE v_tz)::date = c.fecha
    AND (r.slot_inicio AT TIME ZONE v_tz)::time = c.hora_inicio
    AND r.clase_id IS NULL
    AND c.status != 'cancelada';
  GET DIAGNOSTICS v_pass3 = ROW_COUNT;
  RAISE NOTICE 'F3 huérfanas linkeadas a sintéticas: %', v_pass3;

  -- G) Verificación: si quedan reservas activas sin clase_id, RAISE → rollback.
  SELECT count(*) INTO v_orphans_final
  FROM reservas
  WHERE clase_id IS NULL
    AND status IN ('confirmada','completada','no_show');

  IF v_orphans_final > 0 THEN
    RAISE EXCEPTION
      'Migración S4.1 abortada: % reservas activas siguen sin clase_id. Rollback automático.',
      v_orphans_final;
  END IF;

  RAISE NOTICE 'Verificación final OK: 0 reservas activas sin clase_id.';
  RAISE NOTICE 'Resumen pasos: F1=% F2=% F3=%', v_pass1, v_pass2, v_pass3;
END $$;

-- ============================================================================
-- Fin migración S4.1
-- ============================================================================
