-- ============================================================================
-- FIX (default) — anticipación mínima de reserva 24h → 0h para gyms nuevos.
-- ----------------------------------------------------------------------------
-- Decisión: un gym nuevo debe poder reservar clases del MISMO día out-of-the-box.
-- Recreamos crear_tenant_onboarding (de 20260610000000) cambiando solo el default
-- sembrado: config.reserva.anticipacion_min_horas 24 → 0. El dueño sube el umbral
-- desde Reglas si quiere. NO toca tenants existentes (solo el seed de los nuevos).
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
  p_sala_cupo integer,
  p_color_acento text DEFAULT NULL
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
  v_color_acento text := COALESCE(NULLIF(trim(p_color_acento), ''), p_color_primario);
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
      'color_accent', v_color_acento
    ),
    jsonb_build_object(
      'timezone', p_timezone,
      'reserva', jsonb_build_object(
        'duracion_default_min', 60,
        'anticipacion_min_horas', 0,  -- default permisivo: reservar hasta el inicio (el dueño sube el umbral en Reglas)
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
-- TEST (smoke) — el onboarding siembra anticipacion_min_horas = 0.
-- ============================================================================
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc WHERE proname = 'crear_tenant_onboarding' LIMIT 1;
  IF position('''anticipacion_min_horas'', 0' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: el onboarding no siembra anticipacion_min_horas = 0.';
  END IF;
  RAISE NOTICE 'TEST OK: gyms nuevos nacen con anticipacion_min_horas = 0 (reservar hasta el inicio).';
END $$;
