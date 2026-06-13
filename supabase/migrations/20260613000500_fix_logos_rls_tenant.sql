-- ============================================================================
-- FIX M2 — policies del bucket `logos` no ataban el objeto al tenant.
-- ----------------------------------------------------------------------------
-- Las policies de INSERT/UPDATE/DELETE solo exigían `rol='admin'`, sin verificar
-- que el path del objeto pertenezca al tenant del admin. Como los logos se
-- guardan en `{tenant.slug}/...` (AjustesMarca), un admin del gimnasio A podía
-- sobrescribir o borrar los logos del gimnasio B. Las RLS de datos ya aíslan por
-- tenant; esto cierra el mismo hueco en storage.
--
-- Fix: sumar a cada policy que el primer segmento del path
-- (storage.foldername(name))[1] sea el slug del tenant del caller. La lectura
-- pública (SELECT) queda abierta a propósito (los logos son públicos).
-- ============================================================================

DROP POLICY IF EXISTS "Logos admin upload" ON storage.objects;
CREATE POLICY "Logos admin upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'logos'
    AND EXISTS (SELECT 1 FROM usuarios WHERE auth_id = auth.uid() AND rol = 'admin')
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  );

DROP POLICY IF EXISTS "Logos admin update" ON storage.objects;
CREATE POLICY "Logos admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'logos'
    AND EXISTS (SELECT 1 FROM usuarios WHERE auth_id = auth.uid() AND rol = 'admin')
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  )
  WITH CHECK (
    bucket_id = 'logos'
    AND EXISTS (SELECT 1 FROM usuarios WHERE auth_id = auth.uid() AND rol = 'admin')
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  );

DROP POLICY IF EXISTS "Logos admin delete" ON storage.objects;
CREATE POLICY "Logos admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'logos'
    AND EXISTS (SELECT 1 FROM usuarios WHERE auth_id = auth.uid() AND rol = 'admin')
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  );

-- ============================================================================
-- TEST — las policies de escritura quedaron atadas al tenant (referencian el
-- slug del path). Verifica la definición; no simula storage.
-- ============================================================================
DO $$
DECLARE v_qual text;
BEGIN
  SELECT qual INTO v_qual FROM pg_policies
  WHERE tablename = 'objects' AND policyname = 'Logos admin delete';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'TEST FALLO: no existe la policy "Logos admin delete".';
  END IF;
  IF position('foldername' in v_qual) = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: la policy de delete no ata el path al tenant (qual=%).', v_qual;
  END IF;
  RAISE NOTICE 'TEST OK: las policies de logos ataron el objeto al tenant del admin.';
END $$;
