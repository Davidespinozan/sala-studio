-- ============================================================================
-- RLS POLICIES
-- ============================================================================
-- Patrón: PERMISSIVE aditivas. Cada tabla tiene policies por rol.
-- Admin de un tenant: ve y modifica todo de SU tenant.
-- Recepcionista: lee del tenant, modifica solo check-in de reservas.
-- Miembro: lee lo suyo, escribe lo suyo dentro de su tenant.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- tenants
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS tenants_read_own ON tenants;
DROP POLICY IF EXISTS tenants_admin_update ON tenants;
DROP POLICY IF EXISTS tenants_read_public_by_slug ON tenants;

-- Cualquier authenticated puede leer SU tenant (necesario para resolver branding/config)
CREATE POLICY tenants_read_own ON tenants
  FOR SELECT
  TO authenticated
  USING (id = get_my_tenant_id());

-- Anon puede leer tenants por slug (sitio web público sin auth)
CREATE POLICY tenants_read_public_by_slug ON tenants
  FOR SELECT
  TO anon
  USING (status = 'activo');

-- Solo admin del tenant puede actualizar
CREATE POLICY tenants_admin_update ON tenants
  FOR UPDATE
  TO authenticated
  USING (id = get_my_tenant_id() AND is_admin())
  WITH CHECK (id = get_my_tenant_id() AND is_admin());

-- ----------------------------------------------------------------------------
-- usuarios
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS usuarios_read_self ON usuarios;
DROP POLICY IF EXISTS usuarios_read_admin ON usuarios;
DROP POLICY IF EXISTS usuarios_update_self ON usuarios;
DROP POLICY IF EXISTS usuarios_update_admin ON usuarios;
DROP POLICY IF EXISTS usuarios_insert_self ON usuarios;
DROP POLICY IF EXISTS usuarios_insert_admin ON usuarios;

-- Leer su propia fila
CREATE POLICY usuarios_read_self ON usuarios
  FOR SELECT
  TO authenticated
  USING (auth_id = auth.uid());

-- Admin y recepcionista leen TODO el tenant
CREATE POLICY usuarios_read_admin ON usuarios
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- Update propio: solo ciertos campos los puede tocar el usuario (no rol ni status)
-- Nota: la restricción de columnas se aplica en la app, RLS solo decide acceso
CREATE POLICY usuarios_update_self ON usuarios
  FOR UPDATE
  TO authenticated
  USING (auth_id = auth.uid())
  WITH CHECK (auth_id = auth.uid() AND tenant_id = get_my_tenant_id());

-- Admin actualiza cualquier usuario de SU tenant
CREATE POLICY usuarios_update_admin ON usuarios
  FOR UPDATE
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- Insert: solo el trigger on_auth_user_created lo hace (SECURITY DEFINER bypassa RLS).
-- Admin puede insertar manualmente.
CREATE POLICY usuarios_insert_admin ON usuarios
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- ----------------------------------------------------------------------------
-- recursos
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS recursos_read_tenant ON recursos;
DROP POLICY IF EXISTS recursos_read_public ON recursos;
DROP POLICY IF EXISTS recursos_admin_all ON recursos;

-- Authenticated lee recursos de su tenant
CREATE POLICY recursos_read_tenant ON recursos
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id());

-- Anon puede leer recursos activos (para sitio web público)
CREATE POLICY recursos_read_public ON recursos
  FOR SELECT
  TO anon
  USING (activo = true);

-- Admin modifica recursos de su tenant
CREATE POLICY recursos_admin_all ON recursos
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- ----------------------------------------------------------------------------
-- tiers
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS tiers_read_tenant ON tiers;
DROP POLICY IF EXISTS tiers_read_public ON tiers;
DROP POLICY IF EXISTS tiers_admin_all ON tiers;

CREATE POLICY tiers_read_tenant ON tiers
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id());

CREATE POLICY tiers_read_public ON tiers
  FOR SELECT
  TO anon
  USING (activo = true);

CREATE POLICY tiers_admin_all ON tiers
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- ----------------------------------------------------------------------------
-- membresias
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS membresias_read_self ON membresias;
DROP POLICY IF EXISTS membresias_read_admin ON membresias;
DROP POLICY IF EXISTS membresias_admin_all ON membresias;

CREATE POLICY membresias_read_self ON membresias
  FOR SELECT
  TO authenticated
  USING (usuario_id = get_my_user_id());

CREATE POLICY membresias_read_admin ON membresias
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());

CREATE POLICY membresias_admin_all ON membresias
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- ----------------------------------------------------------------------------
-- reservas
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS reservas_read_self ON reservas;
DROP POLICY IF EXISTS reservas_read_admin ON reservas;
DROP POLICY IF EXISTS reservas_admin_all ON reservas;

-- Miembro ve SUS reservas
CREATE POLICY reservas_read_self ON reservas
  FOR SELECT
  TO authenticated
  USING (usuario_id = get_my_user_id());

-- Admin y recepcionista ven todas las reservas del tenant
CREATE POLICY reservas_read_admin ON reservas
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- Admin puede hacer todo
CREATE POLICY reservas_admin_all ON reservas
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- Nota: INSERT/UPDATE de reservas pasa por RPC reservar_recurso_atomic
-- (SECURITY DEFINER bypassa RLS). Las policies de arriba son fallback.

-- ----------------------------------------------------------------------------
-- payment_events (solo admin lee; inserts vienen de service_role/webhooks)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS payment_events_admin_read ON payment_events;

CREATE POLICY payment_events_admin_read ON payment_events
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());

-- No hay policy de INSERT/UPDATE: solo service_role (Netlify Functions) escribe aquí
