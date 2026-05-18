-- ============================================================================
-- PAGOS
-- ============================================================================
-- Journal de todos los eventos de pago de Stripe.
-- Patrón Cubo Polar: idempotency + auditoría completa.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,

  -- Stripe identifiers (uno o ambos según el tipo de evento)
  stripe_event_id text UNIQUE NOT NULL,          -- 'evt_...'
  stripe_event_type text NOT NULL,               -- 'invoice.payment_succeeded', etc.
  stripe_subscription_id text,                   -- 'sub_...'
  stripe_invoice_id text,                        -- 'in_...'
  stripe_customer_id text,                       -- 'cus_...'
  stripe_payment_intent_id text,                 -- 'pi_...'

  -- Referencias internas (si se pudieron resolver)
  usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  membresia_id uuid REFERENCES membresias(id) ON DELETE SET NULL,

  -- Datos del evento
  monto_centavos integer,
  moneda text,
  status text,                                   -- 'succeeded' | 'failed' | etc.

  -- Payload completo (auditoría)
  raw_payload jsonb NOT NULL,

  -- Procesamiento
  processed_at timestamptz,                      -- cuándo se manejó este evento
  processing_error text,                         -- si falló al procesar

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_events_tenant_idx ON payment_events (tenant_id);
CREATE INDEX IF NOT EXISTS payment_events_type_idx ON payment_events (stripe_event_type);
CREATE INDEX IF NOT EXISTS payment_events_sub_idx ON payment_events (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS payment_events_customer_idx ON payment_events (stripe_customer_id);
CREATE INDEX IF NOT EXISTS payment_events_unprocessed_idx ON payment_events (created_at)
  WHERE processed_at IS NULL;

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
