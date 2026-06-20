-- ============================================================================
-- STRIPE Flujo 1 (SALA → gyms) — deja suscripciones_saas lista para Stripe real
-- ----------------------------------------------------------------------------
-- Hoy el pago del tenant al SaaS está mockeado (suscripcionService). Esta
-- migración agrega las columnas que el webhook de Stripe necesita para
-- sincronizar el estado autoritativo de la suscripción, espejando el schema
-- probado de healthyspaceclub (mismo modelo de billing de suscripción directo):
--   · cancel_at_period_end → "se cancela al fin del periodo" (no inmediato).
--   · payment_past_due      → banner de dunning (pago vencido) en el admin.
--   · stripe_price_id       → el price vigente (resuelto desde lookup_key).
--   · ciclo                 → mensual/anual (hoy solo mensual; lo dejamos listo).
--   · last_event_at         → guarda contra eventos out-of-order del webhook.
-- Y crea stripe_webhook_events: idempotencia por event.id (un solo insert-or-
-- ignore por evento), COMPARTIDA por todos los webhooks de Stripe de SALA.
-- Aditiva e idempotente. No mueve dinero — solo prepara el schema.
-- ============================================================================

ALTER TABLE suscripciones_saas
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_past_due     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_price_id      text,
  ADD COLUMN IF NOT EXISTS ciclo                text NOT NULL DEFAULT 'mensual',
  ADD COLUMN IF NOT EXISTS last_event_at        timestamptz;

-- CHECK del ciclo (idempotente).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'suscripciones_saas_ciclo_check'
      AND conrelid = 'suscripciones_saas'::regclass
  ) THEN
    ALTER TABLE suscripciones_saas
      ADD CONSTRAINT suscripciones_saas_ciclo_check CHECK (ciclo IN ('mensual', 'anual'));
  END IF;
END $$;

-- El webhook busca la suscripción por estos IDs → índices para el lookup.
CREATE INDEX IF NOT EXISTS suscripciones_saas_stripe_customer_idx
  ON suscripciones_saas (stripe_customer_id);
CREATE INDEX IF NOT EXISTS suscripciones_saas_stripe_subscription_idx
  ON suscripciones_saas (stripe_subscription_id);

-- ── Idempotencia de webhooks (compartida por todos los endpoints de SALA) ────
-- Un insert-or-ignore por event.id; si ya existe → el evento ya se procesó.
-- event.id es único por cuenta de Stripe, así que sirve para Flujo 1 y Flujo 2.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id         text PRIMARY KEY,         -- event.id de Stripe
  type       text NOT NULL,            -- event.type (para debug/auditoría)
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
-- Sin policies a propósito: solo service_role (que bypassa RLS) la toca. Ningún
-- usuario authenticated puede leer/escribir el log de eventos.

COMMENT ON TABLE stripe_webhook_events IS
  'Idempotencia de webhooks de Stripe (Flujo 1 y 2). insert-or-ignore por event.id; service_role only.';
COMMENT ON COLUMN suscripciones_saas.cancel_at_period_end IS
  'Stripe: la suscripción se cancela al terminar el periodo (no inmediato).';
COMMENT ON COLUMN suscripciones_saas.payment_past_due IS
  'Stripe: pago vencido (dunning). Enciende el banner en el admin del gym.';
COMMENT ON COLUMN suscripciones_saas.last_event_at IS
  'Timestamp del último evento de Stripe aplicado. Guarda contra eventos out-of-order.';

-- Self-test: devuelve tabla (el editor esconde NOTICE).
SELECT
  'flujo1_stripe_ready' AS migracion,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'suscripciones_saas'
      AND column_name IN ('cancel_at_period_end','payment_past_due','stripe_price_id','ciclo','last_event_at')) AS cols_nuevas_de_5,
  (SELECT to_regclass('public.stripe_webhook_events') IS NOT NULL) AS tabla_eventos_ok;
