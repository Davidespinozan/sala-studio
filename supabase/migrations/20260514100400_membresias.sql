-- ============================================================================
-- TIERS (planes de membresía configurables por tenant)
-- ============================================================================
-- Define los planes que cada tenant ofrece.
-- EKKO: Básica $800, Pro $1,200
-- Pilates: Mensual ilimitado $1,500, 8 clases $1,200, etc.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  slug text NOT NULL,                            -- 'basica', 'pro'
  nombre text NOT NULL,                          -- 'Básica', 'Pro'
  descripcion text,

  -- Precio
  precio_centavos integer NOT NULL,              -- 80000 = $800.00 MXN
  moneda text NOT NULL DEFAULT 'MXN',
  periodo text NOT NULL DEFAULT 'mensual'
    CHECK (periodo IN ('mensual', 'anual')),

  -- Beneficios (estructura libre, render UI lo lee y muestra)
  beneficios jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- ej: [
    --   { "label": "Grabación todos los días", "incluido": true },
    --   { "label": "Hasta 60 min por sesión", "incluido": true },
    --   { "label": "Edición IA con CapCut", "incluido": false }
    -- ]

  -- Reglas (overrides del tenant.config para este tier)
  reglas jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- ej: {
    --   "max_invitados": 4,
    --   "permite_recurso_black": true,
    --   "regens_ia_por_mes": 10
    -- }

  -- Stripe
  stripe_price_id text,                          -- 'price_...' del producto recurrente

  -- Estado
  activo boolean NOT NULL DEFAULT true,
  orden integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS tiers_tenant_idx ON tiers (tenant_id);
CREATE INDEX IF NOT EXISTS tiers_activo_idx ON tiers (tenant_id, activo) WHERE activo = true;

DROP TRIGGER IF EXISTS tiers_set_updated_at ON tiers;
CREATE TRIGGER tiers_set_updated_at
  BEFORE UPDATE ON tiers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE tiers ENABLE ROW LEVEL SECURITY;

-- Seed: 2 tiers de EKKO
DO $$
DECLARE
  ekko_tenant_id uuid;
BEGIN
  SELECT id INTO ekko_tenant_id FROM tenants WHERE slug = 'ekko';
  IF ekko_tenant_id IS NULL THEN RETURN; END IF;

  INSERT INTO tiers (tenant_id, slug, nombre, descripcion, precio_centavos, moneda, periodo, beneficios, reglas, orden)
  VALUES
    (
      ekko_tenant_id, 'basica', 'Básica',
      'Acceso diario al estudio. Para creadores que están empezando.',
      80000, 'MXN', 'mensual',
      '[
        {"label": "Grabación todos los días", "incluido": true},
        {"label": "Hasta 60 minutos por sesión", "incluido": true},
        {"label": "Material en MP4 vía Drive", "incluido": true},
        {"label": "Acceso sujeto a disponibilidad", "incluido": true},
        {"label": "Hasta 2 invitados por sesión", "incluido": true},
        {"label": "Edición con IA (CapCut)", "incluido": false},
        {"label": "Miniaturas IA", "incluido": false}
      ]'::jsonb,
      jsonb_build_object(
        'max_invitados', 2,
        'permite_recurso_black', false
      ),
      1
    ),
    (
      ekko_tenant_id, 'pro', 'Pro',
      'Para creadores que producen contenido constante y necesitan más.',
      120000, 'MXN', 'mensual',
      '[
        {"label": "Grabación todos los días", "incluido": true},
        {"label": "Hasta 60 minutos por sesión", "incluido": true},
        {"label": "Material en MP4 vía Drive", "incluido": true},
        {"label": "Acceso sujeto a disponibilidad", "incluido": true},
        {"label": "Hasta 4 invitados por sesión", "incluido": true},
        {"label": "Acceso a estudio Black", "incluido": true},
        {"label": "Edición con IA (CapCut)", "incluido": true},
        {"label": "2 miniaturas por video", "incluido": true}
      ]'::jsonb,
      jsonb_build_object(
        'max_invitados', 4,
        'permite_recurso_black', true
      ),
      2
    )
  ON CONFLICT (tenant_id, slug) DO NOTHING;
END $$;

-- ============================================================================
-- MEMBRESIAS (suscripciones activas/pasadas de cada miembro)
-- ============================================================================
-- 1 fila por cada suscripción Stripe (activa, cancelada, expirada).
-- Un miembro puede tener varias filas históricas, pero solo 1 con
-- status='activa' a la vez.
-- ============================================================================

CREATE TABLE IF NOT EXISTS membresias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tier_id uuid NOT NULL REFERENCES tiers(id) ON DELETE RESTRICT,

  -- Estado
  status text NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente', 'trialing', 'activa', 'past_due',
                      'cancelada', 'expirada')),

  -- Periodos
  trial_starts_at timestamptz,
  trial_ends_at timestamptz,
  periodo_actual_inicio timestamptz,
  periodo_actual_fin timestamptz,
  commitment_ends_at timestamptz,                -- 6 meses desde activa

  -- Cancelación
  cancelada_at timestamptz,
  cancelada_efectiva_at timestamptz,             -- cuándo termina realmente

  -- Stripe
  stripe_subscription_id text UNIQUE,
  stripe_customer_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS membresias_tenant_idx ON membresias (tenant_id);
CREATE INDEX IF NOT EXISTS membresias_usuario_idx ON membresias (usuario_id);
CREATE INDEX IF NOT EXISTS membresias_status_idx ON membresias (tenant_id, status);
CREATE INDEX IF NOT EXISTS membresias_stripe_sub_idx ON membresias (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Un solo activo por usuario a la vez
CREATE UNIQUE INDEX IF NOT EXISTS membresias_one_active_per_user
  ON membresias (usuario_id)
  WHERE status IN ('trialing', 'activa', 'past_due');

DROP TRIGGER IF EXISTS membresias_set_updated_at ON membresias;
CREATE TRIGGER membresias_set_updated_at
  BEFORE UPDATE ON membresias
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE membresias ENABLE ROW LEVEL SECURITY;

-- FK diferida: usuarios.membresia_activa_id → membresias.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_membresia_activa_fk'
  ) THEN
    ALTER TABLE usuarios
      ADD CONSTRAINT usuarios_membresia_activa_fk
      FOREIGN KEY (membresia_activa_id)
      REFERENCES membresias(id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
