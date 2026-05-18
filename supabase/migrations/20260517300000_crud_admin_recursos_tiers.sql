-- ============================================================================
-- Sprint C-CRUD · CRUD admin para recursos y tiers
-- ============================================================================
-- - El UNIQUE (tenant_id, slug) en recursos y tiers ya está en el schema
--   original (migrations 100300 y 100400). No re-aplicamos.
-- - Agregamos índices (tenant_id, activo) para performance de las queries
--   públicas filtradas por activo=true y la separación activos/archivados
--   en admin.
-- - Documentamos el contrato del patrón soft-delete en COMMENT.
-- ============================================================================

CREATE INDEX IF NOT EXISTS recursos_tenant_activo_idx
  ON recursos (tenant_id, activo);

CREATE INDEX IF NOT EXISTS tiers_tenant_activo_idx
  ON tiers (tenant_id, activo);

COMMENT ON COLUMN recursos.activo IS
  'Soft delete: false = archivado. Estudios archivados NO aparecen en landing, member dashboard, ni selector de reservar. Reservas históricas se preservan.';

COMMENT ON COLUMN tiers.activo IS
  'Soft delete: false = archivado. Tiers archivados NO aparecen en signup ni landing. Miembros existentes con tier archivado mantienen su membresía hasta que admin los migre. stripe_price_id se preserva para reportes históricos.';
