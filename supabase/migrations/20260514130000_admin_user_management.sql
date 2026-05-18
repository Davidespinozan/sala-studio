-- ============================================================================
-- Admin user management
-- ============================================================================
-- 1. Eliminar helper dev_crear_recepcionista (reemplazado por UI)
-- 2. Agregar policy para que admin pueda INSERT usuarios via service_role
--    (necesario porque admin-create-user función crea filas desde server)
-- 3. Función helper para contar admins activos (prevenir demotion del último)
-- ============================================================================

DROP FUNCTION IF EXISTS dev_crear_recepcionista(text, text);

-- ============================================================================
-- count_active_admins
-- ============================================================================
-- Cuenta admins activos del tenant actual. Usado por admin-update-role
-- para prevenir que se demote al último admin.
-- ============================================================================

CREATE OR REPLACE FUNCTION count_active_admins(p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COUNT(*)::integer FROM usuarios
  WHERE tenant_id = p_tenant_id
    AND rol = 'admin'
    AND status NOT IN ('cancelado', 'suspendido');
$$;

GRANT EXECUTE ON FUNCTION count_active_admins(uuid) TO authenticated;
