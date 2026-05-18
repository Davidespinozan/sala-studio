-- ============================================================================
-- HELPER FUNCTIONS (resolución de contexto del usuario actual)
-- ============================================================================
-- Todas SECURITY DEFINER porque leen auth.jwt() y la tabla usuarios.
-- Las usan las policies RLS y los RPCs.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_my_user_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id FROM usuarios
  WHERE auth_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_my_tenant_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT tenant_id FROM usuarios
  WHERE auth_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_my_rol()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT rol FROM usuarios
  WHERE auth_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid()
      AND rol = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION is_recepcionista()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid()
      AND rol IN ('recepcionista', 'admin')
  );
$$;

-- Permisos: los roles authenticated y anon pueden invocar estas helpers
GRANT EXECUTE ON FUNCTION get_my_user_id() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_my_tenant_id() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_my_rol() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION is_admin() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION is_recepcionista() TO authenticated, anon;
