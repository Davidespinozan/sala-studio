-- ============================================================================
-- Fix RLS — lectura de `tenants` para usuarios autenticados
-- ============================================================================
-- PROBLEMA:
--   La política `tenants_read_own` permitía a un usuario autenticado leer
--   SOLO su propio tenant (id = get_my_tenant_id()). Pero la app resuelve el
--   tenant desde la URL/subdominio (TenantProvider) y necesita leer ESE
--   tenant, sea cual sea el tenant al que pertenece el usuario logueado.
--
--   Síntoma: estando logueado con un usuario del tenant A, abrir la URL del
--   tenant B (o `localhost`, que resuelve a 'sala-demo') daba
--   "Tenant no encontrado o inactivo" — la query devolvía 0 filas porque el
--   RLS la filtraba.
--
-- FIX:
--   Un usuario autenticado puede leer cualquier tenant ACTIVO — exactamente
--   lo mismo que ya puede el rol `anon` vía `tenants_read_public_by_slug`.
--   No expone nada nuevo: `anon` ya lee `SELECT *` de todos los tenants
--   activos (branding, config, timezone — no hay secretos ahí).
--
--   La escritura NO se toca: `tenants_admin_update` sigue restringida al
--   admin del propio tenant.
--
-- Nota: un tenant con status != 'activo' deja de ser legible (igual que para
-- anon). Es coherente — TenantProvider ya filtra por status='activo' y un
-- tenant suspendido no debe cargar la app para nadie.
-- ============================================================================

DROP POLICY IF EXISTS tenants_read_own ON tenants;

CREATE POLICY tenants_read_active ON tenants
  FOR SELECT
  TO authenticated
  USING (status = 'activo');

DO $$
BEGIN
  RAISE NOTICE 'Fix RLS tenants OK: authenticated puede leer cualquier tenant activo (tenants_read_active). La escritura (tenants_admin_update) no cambió.';
END $$;
