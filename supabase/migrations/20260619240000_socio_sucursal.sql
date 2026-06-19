-- ============================================================================
-- MULTI-SUCURSAL · Fase 1 — el socio tiene una sucursal "home".
-- ----------------------------------------------------------------------------
-- Hoy `usuarios` no tiene sucursal → la app del socio trae todo del tenant sin
-- filtrar y, con 2+ sedes, se mezclan clases/instructores. Esta columna le da
-- al socio su sede "home"; la app filtra por la sede ACTIVA (switcher en
-- localStorage, default = home). La membresía sirve en cualquier sede.
--
-- Gyms de 1 sede: todos los socios quedan apuntados a esa única sede → sin
-- cambios visibles (no hay switcher).
--
-- "Default" del tenant = sucursal de menor `orden` (0) / más antigua, misma
-- convención que el resto del sistema (ver 20260521000000_sucursales.sql).
-- ============================================================================

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS sucursal_id uuid REFERENCES sucursales(id) ON DELETE SET NULL;

COMMENT ON COLUMN usuarios.sucursal_id IS
  'Sucursal "home" del socio (Business 2+ sedes). La pone el admin; la app del socio filtra por la sede ACTIVA (switcher), default = esta. NULL = sin asignar → cae a la default del tenant.';

-- Backfill: cada socio → la sucursal default de su tenant.
UPDATE usuarios u
SET sucursal_id = (
  SELECT s.id
  FROM sucursales s
  WHERE s.tenant_id = u.tenant_id
    AND s.activa
  ORDER BY s.orden ASC, s.created_at ASC
  LIMIT 1
)
WHERE u.sucursal_id IS NULL;

CREATE INDEX IF NOT EXISTS usuarios_sucursal_idx ON usuarios (sucursal_id);
