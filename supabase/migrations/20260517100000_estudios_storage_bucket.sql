-- ============================================================================
-- Sprint B · Verdad visual admin → landing/signup/member
-- ============================================================================
-- Bucket público "estudios" para fotos de los estudios + policies públicas
-- de lectura en recursos y tiers para que la landing (anon) los pueda leer.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'estudios',
  'estudios',
  true,
  5242880, -- 5MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public            = EXCLUDED.public,
  file_size_limit   = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================================
-- Policies del bucket "estudios"
-- ============================================================================

-- 1. SELECT pública (cualquiera lee fotos — landing las muestra a anon)
DROP POLICY IF EXISTS "Estudios públicos lectura" ON storage.objects;
CREATE POLICY "Estudios públicos lectura"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'estudios');

-- 2. INSERT solo admin del tenant
DROP POLICY IF EXISTS "Estudios admin upload" ON storage.objects;
CREATE POLICY "Estudios admin upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'estudios'
    AND EXISTS (
      SELECT 1 FROM usuarios
      WHERE auth_id = auth.uid()
        AND rol = 'admin'
    )
  );

-- 3. UPDATE solo admin
DROP POLICY IF EXISTS "Estudios admin update" ON storage.objects;
CREATE POLICY "Estudios admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'estudios'
    AND EXISTS (
      SELECT 1 FROM usuarios
      WHERE auth_id = auth.uid()
        AND rol = 'admin'
    )
  );

-- 4. DELETE solo admin
DROP POLICY IF EXISTS "Estudios admin delete" ON storage.objects;
CREATE POLICY "Estudios admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'estudios'
    AND EXISTS (
      SELECT 1 FROM usuarios
      WHERE auth_id = auth.uid()
        AND rol = 'admin'
    )
  );

-- ============================================================================
-- Policies públicas de lectura en recursos y tiers para anon
-- La landing pública (sin auth) necesita leer recursos activos y tiers
-- activos. Hardcoded al tenant 'ekko' por ahora; cuando haya multi-tenant
-- real, este filtro debe venir del slug en URL/subdomain.
-- ============================================================================

DROP POLICY IF EXISTS "Recursos públicos activos lectura" ON recursos;
CREATE POLICY "Recursos públicos activos lectura"
  ON recursos FOR SELECT
  TO anon
  USING (
    activo = true
    AND tenant_id IN (SELECT id FROM tenants WHERE slug = 'ekko')
  );

DROP POLICY IF EXISTS "Tiers públicos activos lectura" ON tiers;
CREATE POLICY "Tiers públicos activos lectura"
  ON tiers FOR SELECT
  TO anon
  USING (
    activo = true
    AND tenant_id IN (SELECT id FROM tenants WHERE slug = 'ekko')
  );
