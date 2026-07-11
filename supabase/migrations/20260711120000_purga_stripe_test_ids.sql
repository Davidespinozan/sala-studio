-- ============================================================================
-- ⚠️⚠️  PASO MANUAL DE GO-LIVE — NO es una migración de esquema.  ⚠️⚠️
-- ----------------------------------------------------------------------------
-- Purga los IDs de Stripe de TEST guardados durante la construcción, para que
-- el LIVE arranque limpio. En Stripe, un `cus_…`/`sub_…`/`acct_…` de test NO
-- existe en live → si el código lo reusa, el checkout tira "No such customer" y
-- el cobro real NO abre.
--
-- 🕐 TIMING CRÍTICO: correr esto UNA sola vez, en el CUTOVER test→live (al poner
--    la sk_live en Netlify), ANTES de que se suscriba el primer gym real. NO
--    correrlo si ya hay clientes reales en live (borraría IDs live).
--    Los prefijos cus_/sub_/acct_ son iguales en test y live: la única razón por
--    la que esto es seguro es que HOY todo es test.
--
-- 🟢 El demo (healthyspace) usa IDs `mock_…` y queda INTACTO (se excluye).
-- ============================================================================

-- 1) Cuentas Connect de test en los gyms.
UPDATE tenants SET
  stripe_account_id      = NULL,
  stripe_charges_enabled = false,
  stripe_details_submitted = false
WHERE stripe_account_id IS NOT NULL
  AND stripe_account_id NOT LIKE 'mock_%';

-- 2) Customers de test en usuarios (socios).
UPDATE usuarios SET stripe_customer_id = NULL
WHERE stripe_customer_id IS NOT NULL
  AND stripe_customer_id NOT LIKE 'mock_%';

-- 3) Customer/sub/price de test en las suscripciones SaaS (mensualidad del gym).
UPDATE suscripciones_saas SET
  stripe_customer_id     = NULL,
  stripe_subscription_id = NULL,
  stripe_price_id        = NULL
WHERE (stripe_customer_id     IS NOT NULL AND stripe_customer_id     NOT LIKE 'mock_%')
   OR (stripe_subscription_id IS NOT NULL AND stripe_subscription_id NOT LIKE 'mock_%');

-- 4) Sub/customer de test en las membresías de los socios.
UPDATE membresias SET stripe_subscription_id = NULL
WHERE stripe_subscription_id IS NOT NULL
  AND stripe_subscription_id NOT LIKE 'mock_%';
UPDATE membresias SET stripe_customer_id = NULL
WHERE stripe_customer_id IS NOT NULL
  AND stripe_customer_id NOT LIKE 'mock_%';

-- ── Verificación (devuelve tabla) — se esperan TODAS en 0 ──
SELECT 'tenants con stripe_account_id de test' AS check,
       count(*) AS quedan
FROM tenants WHERE stripe_account_id IS NOT NULL AND stripe_account_id NOT LIKE 'mock_%'
UNION ALL
SELECT 'usuarios con stripe_customer_id de test',
       count(*) FROM usuarios WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id NOT LIKE 'mock_%'
UNION ALL
SELECT 'suscripciones_saas con id de test',
       count(*) FROM suscripciones_saas
       WHERE (stripe_customer_id IS NOT NULL AND stripe_customer_id NOT LIKE 'mock_%')
          OR (stripe_subscription_id IS NOT NULL AND stripe_subscription_id NOT LIKE 'mock_%')
UNION ALL
SELECT 'membresias con id de test',
       count(*) FROM membresias
       WHERE (stripe_subscription_id IS NOT NULL AND stripe_subscription_id NOT LIKE 'mock_%')
          OR (stripe_customer_id     IS NOT NULL AND stripe_customer_id     NOT LIKE 'mock_%');
