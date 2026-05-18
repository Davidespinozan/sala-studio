-- ============================================================================
-- Sprint Final · cancelación de reservas por admin + notificaciones in-app
-- ============================================================================
-- - Agrega `cancelada_por` y `cancelacion_notificada_at` a reservas
--   (las columnas cancelada_at + cancelada_motivo ya existen del schema
--   original).
-- - Crea tabla notificaciones (in-app inbox para miembros).
-- - Crea bucket 'logos' + policies (Sprint Final · branding).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reservas' AND column_name = 'cancelada_por'
  ) THEN
    ALTER TABLE reservas ADD COLUMN cancelada_por uuid REFERENCES usuarios(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reservas' AND column_name = 'cancelacion_notificada_at'
  ) THEN
    ALTER TABLE reservas ADD COLUMN cancelacion_notificada_at timestamptz;
  END IF;
END $$;

-- ============================================================================
-- Tabla notificaciones (inbox in-app)
-- ============================================================================

CREATE TABLE IF NOT EXISTS notificaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  titulo text NOT NULL,
  mensaje text NOT NULL,
  metadata jsonb,
  leida boolean NOT NULL DEFAULT false,
  creada_at timestamptz NOT NULL DEFAULT now(),
  leida_at timestamptz
);

CREATE INDEX IF NOT EXISTS notificaciones_usuario_leida_idx
  ON notificaciones (usuario_id, leida, creada_at DESC);

ALTER TABLE notificaciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Notificaciones: usuario lee las propias" ON notificaciones;
CREATE POLICY "Notificaciones: usuario lee las propias"
  ON notificaciones FOR SELECT
  TO authenticated
  USING (
    usuario_id IN (SELECT id FROM usuarios WHERE auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "Notificaciones: usuario marca leída las propias" ON notificaciones;
CREATE POLICY "Notificaciones: usuario marca leída las propias"
  ON notificaciones FOR UPDATE
  TO authenticated
  USING (
    usuario_id IN (SELECT id FROM usuarios WHERE auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "Notificaciones: admin del tenant crea" ON notificaciones;
CREATE POLICY "Notificaciones: admin del tenant crea"
  ON notificaciones FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM usuarios
      WHERE auth_id = auth.uid() AND rol = 'admin'
    )
  );

COMMENT ON TABLE notificaciones IS
  'Sprint Final: inbox in-app de notificaciones para miembros (reserva cancelada, etc.). Email/SMS pendiente Sprint Resend.';

-- ============================================================================
-- Bucket logos (Sprint Final · Marca)
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'logos',
  'logos',
  true,
  2097152, -- 2MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon']
)
ON CONFLICT (id) DO UPDATE SET
  public            = EXCLUDED.public,
  file_size_limit   = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Logos públicos lectura" ON storage.objects;
CREATE POLICY "Logos públicos lectura"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'logos');

DROP POLICY IF EXISTS "Logos admin upload" ON storage.objects;
CREATE POLICY "Logos admin upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'logos'
    AND EXISTS (SELECT 1 FROM usuarios WHERE auth_id = auth.uid() AND rol = 'admin')
  );

DROP POLICY IF EXISTS "Logos admin update" ON storage.objects;
CREATE POLICY "Logos admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'logos'
    AND EXISTS (SELECT 1 FROM usuarios WHERE auth_id = auth.uid() AND rol = 'admin')
  );

DROP POLICY IF EXISTS "Logos admin delete" ON storage.objects;
CREATE POLICY "Logos admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'logos'
    AND EXISTS (SELECT 1 FROM usuarios WHERE auth_id = auth.uid() AND rol = 'admin')
  );
