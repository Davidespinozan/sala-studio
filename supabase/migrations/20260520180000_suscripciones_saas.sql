-- ============================================================================
-- S7-MOCK — Suscripción del SaaS (pago simulado)
-- ============================================================================
-- SALA le cobra a los gyms (tenants) por usar la plataforma. Esta migración
-- crea la estructura de suscripción. El "pago" se simula en el frontend
-- (ver src/admin/lib/suscripcionService.ts); los campos stripe_* quedan listos
-- para enchufar Stripe real sin cambiar el schema.
--
-- DECISIÓN — single source of truth de precios/límites: NO va en la BD.
-- Los 9 precios (3 tiers × 3 monedas) y los límites por tier son definición
-- comercial estática, no datos por-tenant ni editables. Viven en una constante
-- TS (src/admin/lib/planesSaas.ts). La columna `precio_centavos` guarda el
-- snapshot de lo que paga ESTE tenant (igual que Stripe guarda el precio en la
-- subscription) — así un cambio de precios futuro no altera suscripciones vivas.
--
-- Nombre `suscripciones_saas` (no `suscripciones`) para no confundir con las
-- membresías de los miembros del gym (tabla `membresias`).
-- ============================================================================

CREATE TABLE IF NOT EXISTS suscripciones_saas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Un tenant, una suscripción.
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,

  tier text NOT NULL CHECK (tier IN ('starter', 'pro', 'business')),
  moneda text NOT NULL CHECK (moneda IN ('mxn', 'usd', 'eur')),
  estado text NOT NULL CHECK (estado IN ('trial', 'activa', 'vencida', 'cancelada', 'pausada')),

  trial_termina timestamptz,
  periodo_actual_termina timestamptz,
  -- Precio que paga este tenant, en centavos de su moneda. Snapshot.
  precio_centavos integer NOT NULL CHECK (precio_centavos >= 0),

  -- Campos para Stripe real. El mock los llena con placeholders 'mock_*'.
  stripe_customer_id text,
  stripe_subscription_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelada_at timestamptz
);

DROP TRIGGER IF EXISTS suscripciones_saas_set_updated_at ON suscripciones_saas;
CREATE TRIGGER suscripciones_saas_set_updated_at
  BEFORE UPDATE ON suscripciones_saas
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE suscripciones_saas ENABLE ROW LEVEL SECURITY;

-- RLS: solo el admin del tenant ve y gestiona su propia suscripción.
DROP POLICY IF EXISTS suscripciones_saas_admin_all ON suscripciones_saas;
CREATE POLICY suscripciones_saas_admin_all ON suscripciones_saas
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

COMMENT ON TABLE suscripciones_saas IS
  'S7-mock: suscripción de un tenant (gym) al SaaS SALA. Una fila por tenant. El pago se simula en el frontend; los campos stripe_* quedan para Stripe real.';
COMMENT ON COLUMN suscripciones_saas.precio_centavos IS
  'Snapshot del precio que paga este tenant, en centavos de su moneda. Fuente de los precios de catálogo: src/admin/lib/planesSaas.ts.';
COMMENT ON COLUMN suscripciones_saas.stripe_customer_id IS
  'Stripe customer. El mock guarda mock_cus_*; Stripe real lo llena vía webhook.';

-- ============================================================================
-- SEED — suscripción de ejemplo para sala-demo
-- ============================================================================
-- Pro / activa en MXN, para que el panel se vea poblado. Idempotente.
-- ============================================================================

INSERT INTO suscripciones_saas (
  tenant_id, tier, moneda, estado,
  trial_termina, periodo_actual_termina, precio_centavos,
  stripe_customer_id, stripe_subscription_id
)
SELECT
  t.id, 'pro', 'mxn', 'activa',
  now() - interval '12 days',   -- el trial ya terminó
  now() + interval '18 days',   -- próximo cobro
  390000,                       -- 3900 MXN
  'mock_cus_seed_demo', 'mock_sub_seed_demo'
FROM tenants t
WHERE t.slug = 'sala-demo'
ON CONFLICT (tenant_id) DO NOTHING;

DO $$
BEGIN
  RAISE NOTICE 'Migración suscripciones_saas OK: tabla + RLS + seed sala-demo.';
END $$;
