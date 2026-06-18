-- ============================================================================
-- DEMO HEALTHYSPACE · fix — asignar planes a las salas
-- ----------------------------------------------------------------------------
-- Las salas Cycling y Pilates quedaron con tiers_permitidos VACÍO (de la config
-- de santi). El RPC reservar_clase_atomic exige que el plan del socio esté en
-- recursos.tiers_permitidos; con la lista vacía, NINGÚN plan puede reservar →
-- "Tu plan no tiene acceso a esta sala" (aunque el socio sea Pro).
--
-- Habilitamos ambos planes (basica, pro) en TODAS las salas del demo.
-- ============================================================================

UPDATE recursos
SET tiers_permitidos = ARRAY['basica', 'pro']
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace');
