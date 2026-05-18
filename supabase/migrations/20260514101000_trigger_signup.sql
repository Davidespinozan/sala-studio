-- ============================================================================
-- TRIGGER: on_auth_user_created
-- ============================================================================
-- Cuando se crea un usuario en auth.users (signup), crea su fila en usuarios
-- como 'miembro' del tenant que corresponde al subdominio (por ahora, ekko).
--
-- IMPORTANTE: el trigger asume signup desde la PWA de EKKO. Para SaaS
-- multi-tenant, el tenant se resolverá del request metadata (raw_user_meta_data)
-- que el cliente envía al hacer signUp.
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
  -- Resolver tenant desde metadata o default a 'ekko'
  v_tenant_slug := COALESCE(
    NEW.raw_user_meta_data->>'tenant_slug',
    'ekko'
  );

  SELECT id INTO v_tenant_id FROM tenants WHERE slug = v_tenant_slug;

  IF v_tenant_id IS NULL THEN
    RAISE NOTICE 'Tenant % no existe, usando ekko como fallback', v_tenant_slug;
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'ekko';
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_auth_user();
