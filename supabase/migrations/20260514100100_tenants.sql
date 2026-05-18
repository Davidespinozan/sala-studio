-- ============================================================================
-- TENANTS
-- ============================================================================
-- Cada tenant es un negocio (un EKKO, un estudio de pilates, un crossfit box).
-- TODA tabla operativa lleva tenant_id que apunta aquí.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,                    -- 'ekko', 'pilates-noria', 'crossfit-x'
  nombre text NOT NULL,                          -- 'EKKO Studio', 'Pilates La Noria'
  vertical text NOT NULL DEFAULT 'studio_creadores',
    -- 'studio_creadores' | 'yoga_pilates' | 'gym_libre' | 'cycling' | 'crossfit'

  -- Branding (logos, paleta, fuente, dominio)
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Estructura esperada:
    -- {
    --   "logo_url": "https://...",
    --   "color_primary": "#0A0A0A",
    --   "color_accent": "#D4A93C",
    --   "color_bg": "#F5F1E8",
    --   "font_sans": "Geist",
    --   "favicon_url": "https://..."
    -- }

  -- Reglas de negocio configurables (lo que cambia entre verticals)
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Estructura esperada:
    -- {
    --   "reserva": {
    --     "duracion_default_min": 60,
    --     "cupos_por_recurso": 1,
    --     "permitir_continuas": false,
    --     "anticipacion_min_horas": 24,
    --     "anticipacion_max_dias": 30,
    --     "ventana_check_in_min": 15
    --   },
    --   "penalizaciones": {
    --     "no_show_bloqueo_dias": 7,
    --     "no_show_acumular_para_baja": 3
    --   },
    --   "membresia": {
    --     "commitment_meses": 6,
    --     "trial_dias": 0,
    --     "permite_invitados": true,
    --     "max_invitados_default": 2
    --   },
    --   "acceso": {
    --     "tipo": "qr_recepcion",
    --     "requiere_lista_asistencia": false
    --   },
    --   "ui": {
    --     "etiqueta_miembro": "Miembro",
    --     "etiqueta_recurso": "Estudio",
    --     "etiqueta_sesion": "Sesión"
    --   }
    -- }

  -- Dominios
  dominio_principal text,                       -- 'ekko.studio'
  dominio_app text,                              -- 'app.ekko.studio'

  -- Stripe Connect (para SALA multi-tenant; EKKO usa cuenta directa)
  stripe_account_id text,                       -- 'acct_...' (Connect en futuro)
  stripe_subscription_product_id text,           -- 'prod_...' producto base

  -- Estado
  status text NOT NULL DEFAULT 'activo'
    CHECK (status IN ('activo', 'suspendido', 'cancelado')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenants_slug_idx ON tenants (slug);
CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants (status);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_set_updated_at ON tenants;
CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Seed: EKKO como primer tenant
-- ============================================================================

INSERT INTO tenants (
  slug, nombre, vertical, branding, config, dominio_principal, dominio_app
) VALUES (
  'ekko',
  'EKKO Studio',
  'studio_creadores',
  jsonb_build_object(
    'logo_url', null,
    'color_primary', '#0A0A0A',
    'color_accent', '#D4A93C',
    'color_bg', '#F5F1E8',
    'font_sans', 'Geist',
    'favicon_url', null
  ),
  jsonb_build_object(
    'reserva', jsonb_build_object(
      'duracion_default_min', 60,
      'cupos_por_recurso', 1,
      'permitir_continuas', false,
      'anticipacion_min_horas', 24,
      'anticipacion_max_dias', 30,
      'ventana_check_in_min', 15
    ),
    'penalizaciones', jsonb_build_object(
      'no_show_bloqueo_dias', 7,
      'no_show_acumular_para_baja', 3
    ),
    'membresia', jsonb_build_object(
      'commitment_meses', 6,
      'trial_dias', 0,
      'permite_invitados', true,
      'max_invitados_default', 2
    ),
    'acceso', jsonb_build_object(
      'tipo', 'qr_recepcion',
      'requiere_lista_asistencia', false
    ),
    'ui', jsonb_build_object(
      'etiqueta_miembro', 'Miembro',
      'etiqueta_recurso', 'Estudio',
      'etiqueta_sesion', 'Sesión'
    )
  ),
  'ekko.studio',
  'app.ekko.studio'
)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
