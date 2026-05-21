-- ============================================================================
-- Sprint MULTI-SUCURSAL Nivel 1 — sucursales + migración de datos existentes
-- ============================================================================
-- Hoy: 1 tenant = 1 ubicación. Todo (recursos, instructores, horarios, clases)
-- cuelga directo del tenant. Este sprint agrega la capa "sucursal": un tenant
-- tiene N sucursales y esas entidades pasan a pertenecer a una sucursal.
--
-- MODELO PARA TODOS LOS TENANTS: cada tenant tiene >=1 sucursal. Starter/Pro
-- tienen 1 (transparente, sin UI). Business puede crear N (gate en el frontend).
--
-- PLAN DE MIGRACIÓN SIN ROMPER NADA:
--   A) CREATE TABLE sucursales.
--   B) Crear una "Sucursal Principal" por cada tenant existente, con la tz
--      actual del tenant (config.timezone).
--   C) Agregar sucursal_id (NULLABLE) a recursos/instructores/horarios/clases.
--   D) Backfill: cada fila existente → la sucursal default de su tenant.
--   E) Trigger BEFORE INSERT: si un insert no trae sucursal_id, lo completa con
--      la sucursal default del tenant. Red de seguridad: cubre la ventana entre
--      esta migración y el deploy del código nuevo, y cualquier path futuro.
--   F) Recién entonces: sucursal_id SET NOT NULL (ya no hay filas sin valor).
--   G) Actualizar crear_tenant_onboarding: crea la sucursal default del gym
--      nuevo (si no, el onboarding rompería contra el NOT NULL).
--
-- Resultado: nada se rompe. Los tenants no-Business quedan con 1 sucursal y
-- nunca ven la diferencia. sala-demo funciona idéntico.
--
-- Idempotente: re-correr la migración es seguro.
-- ============================================================================

-- ============================================================================
-- A) TABLA sucursales
-- ============================================================================

CREATE TABLE IF NOT EXISTS sucursales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre text NOT NULL,
  direccion text,
  -- Cada sucursal tiene su propia tz (cadenas en distintas ciudades, S4.4).
  timezone text NOT NULL DEFAULT 'America/Mexico_City',
  activa boolean NOT NULL DEFAULT true,
  orden integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sucursales_tenant ON sucursales (tenant_id);

DROP TRIGGER IF EXISTS sucursales_set_updated_at ON sucursales;
CREATE TRIGGER sucursales_set_updated_at
  BEFORE UPDATE ON sucursales
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE sucursales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sucursales_read_tenant ON sucursales;
CREATE POLICY sucursales_read_tenant ON sucursales
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id());

DROP POLICY IF EXISTS sucursales_admin_all ON sucursales;
CREATE POLICY sucursales_admin_all ON sucursales
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

COMMENT ON TABLE sucursales IS
  'Multi-sucursal N1: cada tenant tiene >=1 sucursal. recursos/instructores/horarios/clases pertenecen a una. Starter/Pro tienen 1; Business puede crear N.';

-- ============================================================================
-- B) SUCURSAL DEFAULT por cada tenant existente
-- ============================================================================
-- Una "Sucursal Principal" por tenant que aún no tenga ninguna, con la tz
-- actual del tenant. orden 0 = la default.
-- ============================================================================

DO $$
DECLARE
  v_creadas integer := 0;
BEGIN
  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden)
  SELECT
    t.id,
    'Sucursal Principal',
    COALESCE(t.config->>'timezone', 'America/Mexico_City'),
    true,
    0
  FROM tenants t
  WHERE NOT EXISTS (SELECT 1 FROM sucursales s WHERE s.tenant_id = t.id);
  GET DIAGNOSTICS v_creadas = ROW_COUNT;
  RAISE NOTICE 'B) Sucursales default creadas: %', v_creadas;
END $$;

-- ============================================================================
-- C) Columna sucursal_id (NULLABLE por ahora) en las tablas por-sucursal
-- ============================================================================

ALTER TABLE recursos
  ADD COLUMN IF NOT EXISTS sucursal_id uuid REFERENCES sucursales(id) ON DELETE RESTRICT;
ALTER TABLE instructores
  ADD COLUMN IF NOT EXISTS sucursal_id uuid REFERENCES sucursales(id) ON DELETE RESTRICT;
ALTER TABLE horarios_recurrentes
  ADD COLUMN IF NOT EXISTS sucursal_id uuid REFERENCES sucursales(id) ON DELETE RESTRICT;
ALTER TABLE clases
  ADD COLUMN IF NOT EXISTS sucursal_id uuid REFERENCES sucursales(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_recursos_sucursal ON recursos (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_instructores_sucursal ON instructores (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_horarios_rec_sucursal ON horarios_recurrentes (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_clases_sucursal ON clases (sucursal_id);

-- ============================================================================
-- D) BACKFILL — cada fila existente → la sucursal default de su tenant
-- ============================================================================
-- "Default" = la sucursal de menor orden (0) / más antigua del tenant.
-- Solo toca filas con sucursal_id NULL → idempotente.
-- ============================================================================

DO $$
DECLARE
  r1 integer; r2 integer; r3 integer; r4 integer;
BEGIN
  UPDATE recursos x SET sucursal_id = (
    SELECT s.id FROM sucursales s WHERE s.tenant_id = x.tenant_id
    ORDER BY s.orden ASC, s.created_at ASC LIMIT 1
  ) WHERE x.sucursal_id IS NULL;
  GET DIAGNOSTICS r1 = ROW_COUNT;

  UPDATE instructores x SET sucursal_id = (
    SELECT s.id FROM sucursales s WHERE s.tenant_id = x.tenant_id
    ORDER BY s.orden ASC, s.created_at ASC LIMIT 1
  ) WHERE x.sucursal_id IS NULL;
  GET DIAGNOSTICS r2 = ROW_COUNT;

  UPDATE horarios_recurrentes x SET sucursal_id = (
    SELECT s.id FROM sucursales s WHERE s.tenant_id = x.tenant_id
    ORDER BY s.orden ASC, s.created_at ASC LIMIT 1
  ) WHERE x.sucursal_id IS NULL;
  GET DIAGNOSTICS r3 = ROW_COUNT;

  UPDATE clases x SET sucursal_id = (
    SELECT s.id FROM sucursales s WHERE s.tenant_id = x.tenant_id
    ORDER BY s.orden ASC, s.created_at ASC LIMIT 1
  ) WHERE x.sucursal_id IS NULL;
  GET DIAGNOSTICS r4 = ROW_COUNT;

  RAISE NOTICE 'D) Backfill — recursos:% instructores:% horarios:% clases:%', r1, r2, r3, r4;
END $$;

-- ============================================================================
-- E) TRIGGER — autocompletar sucursal_id con la default del tenant
-- ============================================================================
-- Red de seguridad: si un INSERT no trae sucursal_id, se completa con la
-- sucursal default. Cubre la ventana entre esta migración y el deploy del
-- código nuevo, y cualquier path que olvide setearla.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_asignar_sucursal_default()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sucursal_id IS NULL THEN
    SELECT id INTO NEW.sucursal_id
    FROM sucursales
    WHERE tenant_id = NEW.tenant_id
    ORDER BY orden ASC, created_at ASC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION trg_asignar_sucursal_default() FROM PUBLIC;

DROP TRIGGER IF EXISTS recursos_sucursal_default ON recursos;
CREATE TRIGGER recursos_sucursal_default
  BEFORE INSERT ON recursos
  FOR EACH ROW EXECUTE FUNCTION trg_asignar_sucursal_default();

DROP TRIGGER IF EXISTS instructores_sucursal_default ON instructores;
CREATE TRIGGER instructores_sucursal_default
  BEFORE INSERT ON instructores
  FOR EACH ROW EXECUTE FUNCTION trg_asignar_sucursal_default();

DROP TRIGGER IF EXISTS horarios_rec_sucursal_default ON horarios_recurrentes;
CREATE TRIGGER horarios_rec_sucursal_default
  BEFORE INSERT ON horarios_recurrentes
  FOR EACH ROW EXECUTE FUNCTION trg_asignar_sucursal_default();

DROP TRIGGER IF EXISTS clases_sucursal_default ON clases;
CREATE TRIGGER clases_sucursal_default
  BEFORE INSERT ON clases
  FOR EACH ROW EXECUTE FUNCTION trg_asignar_sucursal_default();

-- ============================================================================
-- F) SET NOT NULL — ya no quedan filas sin sucursal_id
-- ============================================================================
-- Si algo quedó NULL, este paso falla ruidosamente y aborta la migración
-- (rollback) — no deja el schema a medias.
-- ============================================================================

ALTER TABLE recursos             ALTER COLUMN sucursal_id SET NOT NULL;
ALTER TABLE instructores         ALTER COLUMN sucursal_id SET NOT NULL;
ALTER TABLE horarios_recurrentes ALTER COLUMN sucursal_id SET NOT NULL;
ALTER TABLE clases               ALTER COLUMN sucursal_id SET NOT NULL;

COMMENT ON COLUMN recursos.sucursal_id IS 'Multi-sucursal N1: sala pertenece a esta sucursal.';
COMMENT ON COLUMN clases.sucursal_id IS 'Multi-sucursal N1: heredada del horario/sala. Las clases usan la tz de SU sucursal.';

-- ============================================================================
-- G) crear_tenant_onboarding — ahora crea la sucursal default del gym nuevo
-- ============================================================================
-- Sin esto, el onboarding rompería: el INSERT del recurso violaría el NOT NULL
-- (un tenant recién creado no tiene sucursal todavía).
-- ============================================================================

CREATE OR REPLACE FUNCTION crear_tenant_onboarding(
  p_auth_id uuid,
  p_admin_nombre text,
  p_admin_email text,
  p_gym_nombre text,
  p_slug text,
  p_timezone text,
  p_tier_saas text,
  p_moneda text,
  p_precio_centavos integer,
  p_color_primario text,
  p_logo_url text,
  p_sala_nombre text,
  p_sala_cupo integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_sucursal_id uuid;
  v_sala_slug text;
  v_fin_trial timestamptz := now() + interval '7 days';
BEGIN
  -- ── 1. Tenant ──
  INSERT INTO tenants (slug, nombre, vertical, branding, config, status)
  VALUES (
    p_slug,
    p_gym_nombre,
    'gym_libre',
    jsonb_build_object(
      'logo_url', p_logo_url,
      'color_primary', p_color_primario,
      'color_bg', '#F5F1E8',
      'color_accent', '#D4A93C'
    ),
    jsonb_build_object(
      'timezone', p_timezone,
      'reserva', jsonb_build_object(
        'duracion_default_min', 60,
        'anticipacion_min_horas', 24,
        'anticipacion_max_dias', 30,
        'permitir_continuas', false,
        'ventana_check_in_min', 15
      ),
      'membresia', jsonb_build_object(
        'commitment_meses', 0,
        'permite_invitados', true,
        'max_invitados_default', 2
      )
    ),
    'activo'
  )
  RETURNING id INTO v_tenant_id;

  -- ── 1b. Sucursal default del gym nuevo ──
  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden)
  VALUES (v_tenant_id, 'Sucursal Principal', p_timezone, true, 0)
  RETURNING id INTO v_sucursal_id;

  -- ── 2. Usuario admin (vinculado al auth user ya creado) ──
  INSERT INTO usuarios (auth_id, tenant_id, email, nombre, rol, status)
  VALUES (p_auth_id, v_tenant_id, lower(p_admin_email), p_admin_nombre, 'admin', 'activo');

  -- ── 3. Suscripción al SaaS (trial 7 días, pago mock) ──
  INSERT INTO suscripciones_saas (
    tenant_id, tier, moneda, estado,
    trial_termina, periodo_actual_termina, precio_centavos,
    stripe_customer_id, stripe_subscription_id
  )
  VALUES (
    v_tenant_id, p_tier_saas, p_moneda, 'trial',
    v_fin_trial, v_fin_trial, p_precio_centavos,
    'mock_cus_' || substr(md5(random()::text), 1, 10),
    'mock_sub_' || substr(md5(random()::text), 1, 10)
  );

  -- ── 4. Tiers base del gym (basica + pro). ──
  INSERT INTO tiers (tenant_id, slug, nombre, descripcion, precio_centavos, moneda, periodo, activo, orden)
  VALUES
    (v_tenant_id, 'basica', 'Básica',
     'Plan de entrada. Editá el precio y los beneficios desde Planes.',
     0, upper(p_moneda), 'mensual', true, 1),
    (v_tenant_id, 'pro', 'Pro',
     'Plan completo. Editá el precio y los beneficios desde Planes.',
     0, upper(p_moneda), 'mensual', true, 2);

  -- ── 5. Primera sala (en la sucursal default) ──
  v_sala_slug := COALESCE(
    NULLIF(trim(both '-' from lower(regexp_replace(p_sala_nombre, '[^a-z0-9]+', '-', 'gi'))), ''),
    'sala-1'
  );
  INSERT INTO recursos (
    tenant_id, sucursal_id, slug, nombre, tipo, cupos, cupo_max_default,
    tiers_permitidos, horarios, activo, orden
  )
  VALUES (
    v_tenant_id, v_sucursal_id, v_sala_slug, p_sala_nombre, 'sala_grupal',
    p_sala_cupo, p_sala_cupo,
    ARRAY['basica', 'pro'], '[]'::jsonb, true, 1
  );

  RETURN jsonb_build_object('success', true, 'tenant_id', v_tenant_id, 'slug', p_slug);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'SLUG_TOMADO: El subdominio "%" ya está en uso', p_slug;
END;
$$;

-- ============================================================================
-- H) VERIFICACIÓN FINAL
-- ============================================================================

DO $$
DECLARE
  v_nulls integer;
  v_sucursales integer;
BEGIN
  SELECT count(*) INTO v_nulls FROM (
    SELECT 1 FROM recursos WHERE sucursal_id IS NULL
    UNION ALL SELECT 1 FROM instructores WHERE sucursal_id IS NULL
    UNION ALL SELECT 1 FROM horarios_recurrentes WHERE sucursal_id IS NULL
    UNION ALL SELECT 1 FROM clases WHERE sucursal_id IS NULL
  ) q;

  IF v_nulls > 0 THEN
    RAISE EXCEPTION 'Quedaron % filas sin sucursal_id — abortar.', v_nulls;
  END IF;

  SELECT count(*) INTO v_sucursales FROM sucursales;
  RAISE NOTICE 'Migración multi-sucursal OK. Sucursales totales: %. Cero filas sin sucursal_id.', v_sucursales;
END $$;
