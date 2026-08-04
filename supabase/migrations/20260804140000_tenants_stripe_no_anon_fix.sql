-- ── FIX (corrige 20260804130000) ────────────────────────────────────────────
--
-- El REVOKE de columna de la migración anterior NO restringió nada: anon y
-- authenticated tienen SELECT a NIVEL DE TABLA sobre `tenants`, que ANULA el
-- REVOKE por columna (a diferencia de `usuarios`, que no tenía ese grant). Para
-- restringir de verdad hay que QUITAR el SELECT de tabla y re-otorgar SELECT
-- SOLO de las columnas públicas (todas menos las de Stripe).
--
-- El frontend solo lee columnas públicas (TenantProvider ya usa lista explícita;
-- ningún query de cliente lee las de Stripe), así que el sitio y la app siguen
-- cargando. El backend (service_role) conserva acceso total.

REVOKE SELECT ON tenants FROM PUBLIC;
REVOKE SELECT ON tenants FROM anon;
REVOKE SELECT ON tenants FROM authenticated;

-- Columnas públicas = TODAS menos stripe_account_id / stripe_subscription_product_id.
GRANT SELECT (id, slug, nombre, vertical, branding, config, dominio_principal, dominio_app, status, created_at, updated_at)
  ON tenants TO anon;
GRANT SELECT (id, slug, nombre, vertical, branding, config, dominio_principal, dominio_app, status, created_at, updated_at)
  ON tenants TO authenticated;

-- El backend sigue leyendo TODO (webhooks, saas billing).
GRANT SELECT ON tenants TO service_role;

-- ── Verificación (devuelve TABLA) — todas deben dar 'pasa' = true ───────────
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
SELECT 'anon SÍ sigue leyendo nombre',
       has_column_privilege('anon', 'tenants', 'nombre', 'SELECT')
UNION ALL
SELECT 'anon SÍ sigue leyendo branding',
       has_column_privilege('anon', 'tenants', 'branding', 'SELECT')
UNION ALL
SELECT 'anon SÍ sigue leyendo config',
       has_column_privilege('anon', 'tenants', 'config', 'SELECT')
UNION ALL
SELECT 'authenticated SÍ sigue leyendo config',
       has_column_privilege('authenticated', 'tenants', 'config', 'SELECT');