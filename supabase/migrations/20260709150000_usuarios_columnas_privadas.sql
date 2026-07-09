-- ============================================================================
-- Hardening #3 (detectado al comparar con ekko-studio): columnas sensibles de
-- `usuarios` legibles por recepción vía API.
-- ----------------------------------------------------------------------------
-- La policy usuarios_read_admin usa is_recepcionista() → una recepcionista podía
-- SELECT stripe_customer_id / ob_data (id de cliente de Stripe + PII de
-- onboarding) de TODOS los socios de su tenant. RLS es por FILA, no por columna,
-- así que se cierra con GRANTS a nivel de COLUMNA: se revoca el SELECT de esas
-- dos columnas para authenticated/anon; el backend (service_role) las sigue
-- leyendo (metodo-pago, webhooks, etc.).
--
-- El frontend NO leía esas columnas; los 4 select('*') sobre usuarios se
-- cambiaron a lista explícita (COLUMNAS_USUARIO_CLIENTE) en el mismo commit.
--
-- Bonus: se elimina dev_crear_recepcionista (otro helper DEV, SECURITY DEFINER,
-- RETURNS usuarios; hoy inerte porque apunta al tenant 'sala-demo' ya borrado,
-- pero decía "eliminar antes de producción" y devolvía el composite de usuarios).
-- ============================================================================

-- ── 1. Eliminar helper de DEV ──
DROP FUNCTION IF EXISTS dev_crear_recepcionista(text, text);

-- ── 2. Columnas sensibles: solo service_role ──
-- Explícito primero para que el REVOKE de abajo nunca deje sin acceso al backend.
GRANT  SELECT (stripe_customer_id, ob_data) ON usuarios TO service_role;
REVOKE SELECT (stripe_customer_id, ob_data) ON usuarios FROM PUBLIC;
REVOKE SELECT (stripe_customer_id, ob_data) ON usuarios FROM authenticated;
REVOKE SELECT (stripe_customer_id, ob_data) ON usuarios FROM anon;

-- ── Verificación (devuelve tabla) ──
SELECT 'authenticated NO lee stripe_customer_id' AS check,
       NOT has_column_privilege('authenticated', 'usuarios', 'stripe_customer_id', 'SELECT') AS ok
UNION ALL
SELECT 'authenticated NO lee ob_data',
       NOT has_column_privilege('authenticated', 'usuarios', 'ob_data', 'SELECT')
UNION ALL
SELECT 'anon NO lee stripe_customer_id',
       NOT has_column_privilege('anon', 'usuarios', 'stripe_customer_id', 'SELECT')
UNION ALL
SELECT 'service_role SÍ lee stripe_customer_id',
       has_column_privilege('service_role', 'usuarios', 'stripe_customer_id', 'SELECT')
UNION ALL
SELECT 'dev_crear_recepcionista eliminada',
       NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'dev_crear_recepcionista');
