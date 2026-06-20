-- ============================================================================
-- STRIPE Flujo 2 (gym → socios) — groundwork de Connect (Express)
-- ----------------------------------------------------------------------------
-- El gym es una CUENTA CONECTADA: cobra a sus socios, la plata va a SU banco;
-- SALA es la plataforma (nunca toca los fondos). `tenants.stripe_account_id`
-- (acct_...) YA existe. Acá agregamos el estado del onboarding de la cuenta,
-- que escribe connect-status / el webhook de Connect:
--   · stripe_charges_enabled    → la cuenta puede COBRAR (onboarding completo).
--   · stripe_details_submitted  → el dueño terminó el formulario hospedado.
-- El front gatea el "Activar cobros" con esto; el checkout del socio (Flujo 2)
-- exigirá charges_enabled antes de cobrar. Aditiva, no mueve dinero.
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.stripe_charges_enabled IS
  'Connect: la cuenta conectada del gym puede cobrar (onboarding completo). Lo setea connect-status / webhook de Connect.';
COMMENT ON COLUMN tenants.stripe_details_submitted IS
  'Connect: el dueño completó el onboarding hospedado de Stripe (puede faltar verificación).';

-- Self-test (devuelve tabla).
SELECT
  'connect_groundwork' AS migracion,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'tenants'
      AND column_name IN ('stripe_account_id','stripe_charges_enabled','stripe_details_submitted')) AS cols_connect_de_3;
