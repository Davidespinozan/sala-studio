-- ============================================================================
-- FIX DEMO: el trigger on_auth_user_created debe SALTARSE a los visitantes
-- anónimos del demo.
-- ----------------------------------------------------------------------------
-- signInAnonymously() crea una fila en auth.users SIN email. El trigger
-- handle_new_auth_user() intentaba insertar en usuarios con email = NULL y
-- reventaba contra el NOT NULL → /auth/v1/signup respondía 500 y el demo no
-- abría (admin/miembro/recepción).
--
-- De la fila en usuarios del visitante ya se encarga provisionar_demo() (con el
-- rol/tenant elegido). Si el trigger también insertara, chocaría además contra
-- auth_id UNIQUE. Por eso: early-return para anónimos.
--
-- Se re-define la función completa (versión vigente de 20260520190000) con el
-- guard agregado.
-- ============================================================================

CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_tenant_slug text;
  v_nombre text;
  v_telefono text;
BEGIN
  -- DEMO: los visitantes anónimos no llevan fila de usuarios automática;
  -- provisionar_demo() crea la suya con el rol/tenant elegido.
  IF COALESCE(NEW.is_anonymous, false) THEN
    RETURN NEW;
  END IF;

  -- S9: el onboarding self-service crea su propio usuario admin en
  -- crear_tenant_onboarding(). El trigger no debe insertar nada acá.
  IF COALESCE(NEW.raw_user_meta_data->>'onboarding', '') = 'true' THEN
    RETURN NEW;
  END IF;

  -- Resolver tenant desde metadata o default a 'sala-demo'
  v_tenant_slug := COALESCE(
    NEW.raw_user_meta_data->>'tenant_slug',
    'sala-demo'
  );

  SELECT id INTO v_tenant_id FROM tenants WHERE slug = v_tenant_slug;

  IF v_tenant_id IS NULL THEN
    RAISE NOTICE 'Tenant % no existe, usando sala-demo como fallback', v_tenant_slug;
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'sala-demo';
  END IF;

  v_nombre := NEW.raw_user_meta_data->>'nombre';
  v_telefono := NEW.raw_user_meta_data->>'telefono';

  INSERT INTO usuarios (
    auth_id, tenant_id, email, nombre, telefono, rol, status
  ) VALUES (
    NEW.id,
    v_tenant_id,
    NEW.email,
    v_nombre,
    v_telefono,
    'miembro',
    'pendiente_onboarding'
  )
  ON CONFLICT (tenant_id, email) DO NOTHING;

  RETURN NEW;
END;
$$;
