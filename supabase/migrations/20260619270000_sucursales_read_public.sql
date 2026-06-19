-- ============================================================================
-- MULTI-SUCURSAL · Fase 2 — lectura pública de sucursales (landing).
-- ----------------------------------------------------------------------------
-- La landing del gym es pre-login (anon). Para mostrar la sección "Sucursales"
-- (foto/nombre/dirección de cada sede), anon necesita poder LEER las sucursales
-- activas, igual que ya puede leer recursos/instructores (read_public).
-- Sólo lectura de sedes activas; el resto (admin) ya está cubierto.
-- ============================================================================

DROP POLICY IF EXISTS sucursales_read_public ON sucursales;
CREATE POLICY sucursales_read_public ON sucursales
  FOR SELECT
  TO anon
  USING (activa = true);
