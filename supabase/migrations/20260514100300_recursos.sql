-- ============================================================================
-- RECURSOS
-- ============================================================================
-- Espacios físicos reservables del tenant.
-- EKKO: 3 estudios (Estudio 1, Estudio 2, Black)
-- Yoga: 1 sala con N cupos
-- Cycling: N bicis numeradas en 1 sala
-- ============================================================================

CREATE TABLE IF NOT EXISTS recursos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Identidad
  slug text NOT NULL,                            -- 'estudio-1', 'black', 'bici-7'
  nombre text NOT NULL,                          -- 'Estudio 1', 'Black', 'Bici 7'
  descripcion text,
  tipo text NOT NULL DEFAULT 'estudio_individual'
    CHECK (tipo IN ('estudio_individual', 'sala_grupal', 'maquina', 'bici', 'pase_libre')),

  -- Capacidad
  cupos integer NOT NULL DEFAULT 1,             -- 1 para EKKO, 20-30 para yoga/cycling

  -- Disponibilidad
  -- horarios jsonb: array de bloques semanales
  -- ej: [
  --   { "dia": "lunes", "inicio": "09:00", "fin": "22:00" },
  --   { "dia": "martes", "inicio": "09:00", "fin": "22:00" },
  --   ...
  -- ]
  horarios jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Restricciones (qué tier de membresía puede usar este recurso)
  -- ej: ['basica', 'pro'] o ['pro'] si Black es Pro-only
  tiers_permitidos text[] NOT NULL DEFAULT ARRAY['basica', 'pro'],

  -- Media
  fotos_urls text[] NOT NULL DEFAULT ARRAY[]::text[],
  video_url text,

  -- Estado
  activo boolean NOT NULL DEFAULT true,
  orden integer NOT NULL DEFAULT 0,             -- orden de display en UI

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS recursos_tenant_idx ON recursos (tenant_id);
CREATE INDEX IF NOT EXISTS recursos_activo_idx ON recursos (tenant_id, activo) WHERE activo = true;

DROP TRIGGER IF EXISTS recursos_set_updated_at ON recursos;
CREATE TRIGGER recursos_set_updated_at
  BEFORE UPDATE ON recursos
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE recursos ENABLE ROW LEVEL SECURITY;

-- Seed: 3 estudios de EKKO
DO $$
DECLARE
  ekko_tenant_id uuid;
  horarios_default jsonb;
BEGIN
  SELECT id INTO ekko_tenant_id FROM tenants WHERE slug = 'ekko';

  IF ekko_tenant_id IS NULL THEN
    RAISE NOTICE 'Tenant ekko no existe; saltando seed de recursos';
    RETURN;
  END IF;

  horarios_default := '[
    {"dia": "lunes", "inicio": "09:00", "fin": "22:00"},
    {"dia": "martes", "inicio": "09:00", "fin": "22:00"},
    {"dia": "miercoles", "inicio": "09:00", "fin": "22:00"},
    {"dia": "jueves", "inicio": "09:00", "fin": "22:00"},
    {"dia": "viernes", "inicio": "09:00", "fin": "22:00"},
    {"dia": "sabado", "inicio": "10:00", "fin": "20:00"},
    {"dia": "domingo", "inicio": "10:00", "fin": "18:00"}
  ]'::jsonb;

  INSERT INTO recursos (tenant_id, slug, nombre, tipo, cupos, horarios, tiers_permitidos, orden)
  VALUES
    (ekko_tenant_id, 'estudio-1', 'Estudio 1', 'estudio_individual', 1, horarios_default, ARRAY['basica', 'pro'], 1),
    (ekko_tenant_id, 'estudio-2', 'Estudio 2', 'estudio_individual', 1, horarios_default, ARRAY['basica', 'pro'], 2),
    (ekko_tenant_id, 'black',     'Black',     'estudio_individual', 1, horarios_default, ARRAY['pro'],          3)
  ON CONFLICT (tenant_id, slug) DO NOTHING;
END $$;
