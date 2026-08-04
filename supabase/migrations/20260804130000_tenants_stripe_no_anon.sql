-- ── FIX seguridad: no exponer las columnas de Stripe de `tenants` ───────────
--
-- La policy `tenants_read_public_by_slug` (TO anon, USING status='activo') deja
-- que CUALQUIER visitante anónimo lea TODA la fila de CUALQUIER gym activo — lo
-- que incluye `stripe_account_id` y `stripe_subscription_product_id`. RLS es por
-- FILA, no por columna, así que se cierra con GRANTS a nivel de COLUMNA, igual
-- que se hizo con `usuarios` (20260709150000).
--
-- El frontend NO usa esas columnas; TenantProvider ya pide columnas explícitas
-- (no 'select(*)') en el mismo cambio, así que el sitio público sigue cargando.
-- El backend (service_role) las sigue leyendo (webhooks, saas billing).

-- Explícito primero para que el REVOKE nunca deje sin acceso al backend.
GRANT  SELECT (stripe_account_id, stripe_subscription_product_id) ON tenants TO service_role;
REVOKE SELECT (stripe_account_id, stripe_subscription_product_id) ON tenants FROM PUBLIC;
REVOKE SELECT (stripe_account_id, stripe_subscription_product_id) ON tenants FROM authenticated;
REVOKE SELECT (stripe_account_id, stripe_subscription_product_id) ON tenants FROM anon;

-- ── Verificación (devuelve TABLA) ───────────────────────────────────────────
SELECT 'anon NO lee stripe_account_id' AS prueba,
       NOT has_column_privilege('anon', 'tenants', 'stripe_account_id', 'SELECT') AS pasa
UNION ALL
SELECT 'anon NO lee stripe_subscription_product_id',
       NOT has_column_privilege('anon', 'tenants', 'stripe_subscription_product_id', 'SELECT')
UNION ALL
SELECT 'authenticated NO lee stripe_account_id',
       NOT has_column_privilege('authenticated', 'tenants', 'stripe_account_id', 'SELECT')
UNION ALL
SELECT 'service_role SÍ lee stripe_account_id',
       has_column_privilege('service_role', 'tenants', 'stripe_account_id', 'SELECT')
UNION ALL
SELECT 'anon SÍ sigue leyendo nombre/branding',
       has_column_privilege('anon', 'tenants', 'nombre', 'SELECT')
       AND has_column_privilege('anon', 'tenants', 'branding', 'SELECT');