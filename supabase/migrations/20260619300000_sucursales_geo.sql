-- ============================================================================
-- SUCURSALES: coordenadas para el mapa (Fase 4 multi-sucursal)
-- ----------------------------------------------------------------------------
-- Agrega lat/lng a sucursales para renderizar un mapa (Leaflet + OpenStreetMap)
-- en la landing: dentro del popout de cada sede (multisede) y en la sección
-- "Dónde estamos" de un gym de una sola sede. El admin fija el pin desde
-- Admin → Sucursales. La `direccion` (texto) se mantiene para el "Cómo llegar".
-- ============================================================================

ALTER TABLE sucursales
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision;

-- Seed del demo (healthyspace) para que el mapa se vea sin que el admin
-- tenga que ubicarlas a mano. current_user = postgres → los guardrails no
-- bloquean esta migración.
UPDATE sucursales s
SET lat = 19.4270, lng = -99.1677
WHERE s.tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace')
  AND s.lat IS NULL
  AND lower(s.nombre) LIKE '%principal%';

UPDATE sucursales s
SET lat = 24.8087, lng = -107.3940
WHERE s.tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace')
  AND s.lat IS NULL
  AND lower(s.nombre) LIKE '%culiac%';
