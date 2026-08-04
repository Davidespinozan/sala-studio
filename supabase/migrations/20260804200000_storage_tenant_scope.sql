-- ── H3 — atar la ESCRITURA de storage al tenant (estudios + avatars) ──────────
-- Las policies de escritura de `estudios` y `avatars` solo exigían rol admin/staff,
-- sin atar el objeto al tenant → un admin del gym A podía sobrescribir/borrar fotos
-- del gym B. Es el mismo hueco que ya se cerró para `logos` (20260613000500), pero
-- nunca se aplicó aquí. La LECTURA sigue pública a propósito (fotos públicas).
--
-- Ojo: las rutas NO son homogéneas, por eso cada bucket lleva su propio check:
--   avatars  → `<usuario_id>/<ts>.<ext>`         (MiembroDetalle / datosSocio)
--   estudios → `<slug>/…`                          (Recursos, Sucursales, Landing, Horarios)
--              `instructores/<slug>/…`             (Instructores)
-- Se valida contra get_my_tenant_id(), no contra un dato del cliente.

-- ── AVATARS: el primer segmento (usuario_id) debe ser un socio de mi tenant ───
DROP POLICY IF EXISTS "avatars_admin_write" ON storage.objects;
CREATE POLICY "avatars_admin_write"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND is_admin()
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM usuarios WHERE tenant_id = get_my_tenant_id()
    )
  );

DROP POLICY IF EXISTS "avatars_admin_update" ON storage.objects;
CREATE POLICY "avatars_admin_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND is_admin()
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM usuarios WHERE tenant_id = get_my_tenant_id()
    )
  );

DROP POLICY IF EXISTS "avatars_admin_delete" ON storage.objects;
CREATE POLICY "avatars_admin_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND is_admin()
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM usuarios WHERE tenant_id = get_my_tenant_id()
    )
  );

-- ── ESTUDIOS: el slug del tenant debe ser el 1er segmento, o el 2º cuando la
--    ruta arranca con `instructores/` ──────────────────────────────────────────
DROP POLICY IF EXISTS "Estudios admin upload" ON storage.objects;
CREATE POLICY "Estudios admin upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'estudios'
    AND is_admin()
    AND (
      (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
      OR ((storage.foldername(name))[1] = 'instructores'
          AND (storage.foldername(name))[2] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id()))
    )
  );

DROP POLICY IF EXISTS "Estudios admin update" ON storage.objects;
CREATE POLICY "Estudios admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'estudios'
    AND is_admin()
    AND (
      (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
      OR ((storage.foldername(name))[1] = 'instructores'
          AND (storage.foldername(name))[2] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id()))
    )
  );

DROP POLICY IF EXISTS "Estudios admin delete" ON storage.objects;
CREATE POLICY "Estudios admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'estudios'
    AND is_admin()
    AND (
      (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
      OR ((storage.foldername(name))[1] = 'instructores'
          AND (storage.foldername(name))[2] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id()))
    )
  );

-- ── Self-test (devuelve tabla): las 6 policies deben referenciar foldername
--    (atan el objeto al tenant) y get_my_tenant_id. ─────────────────────────────
SELECT policyname,
       (position('foldername' in coalesce(qual, with_check)) > 0) AS ata_al_path,
       (position('get_my_tenant_id' in coalesce(qual, with_check)) > 0) AS usa_tenant
FROM pg_policies
WHERE tablename = 'objects'
  AND policyname IN (
    'avatars_admin_write','avatars_admin_update','avatars_admin_delete',
    'Estudios admin upload','Estudios admin update','Estudios admin delete'
  )
ORDER BY policyname;
