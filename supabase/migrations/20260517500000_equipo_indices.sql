-- ============================================================================
-- Sprint Equipo · separación Miembros (clientes) vs Equipo (staff)
-- ============================================================================
-- - Índice (tenant_id, rol) para filtrar rápido por rol en admin/miembros y
--   admin/equipo.
-- - Función count_admins_activos para bloquear revocación del último admin.
-- - Columna `invitado boolean` para distinguir invitaciones pendientes de
--   personas con sesión real.
-- ============================================================================

CREATE INDEX IF NOT EXISTS usuarios_tenant_rol_idx
  ON usuarios (tenant_id, rol);

CREATE OR REPLACE FUNCTION count_admins_activos(p_tenant_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM usuarios
  WHERE tenant_id = p_tenant_id
    AND rol = 'admin'
    AND status = 'activo';
$$;

GRANT EXECUTE ON FUNCTION count_admins_activos(uuid) TO authenticated;

COMMENT ON FUNCTION count_admins_activos IS
  'Sprint Equipo: usado para bloquear revocación del último admin del tenant.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'usuarios' AND column_name = 'invitado'
  ) THEN
    ALTER TABLE usuarios
      ADD COLUMN invitado boolean NOT NULL DEFAULT false;

    COMMENT ON COLUMN usuarios.invitado IS
      'Sprint Equipo: true si fue invitado por admin pero todavía no completó signup (auth_id sigue NULL).';
  END IF;
END $$;
