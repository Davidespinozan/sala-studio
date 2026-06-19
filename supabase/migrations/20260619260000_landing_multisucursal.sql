-- ============================================================================
-- MULTI-SUCURSAL · Fase 2 — landing del gym.
-- ----------------------------------------------------------------------------
--  1) recursos.destacado + instructores.destacado → curación del landing: las
--     secciones Salas/Instructores muestran solo destacados (cap en el código).
--     Si el gym no marca ninguno, el código cae a "todos" (no rompe a quien no
--     cura).
--  2) sucursales.foto_url + descripcion → alimentan la sección "Sucursales"
--     (card por sede + popout con sus salas/instructores).
--  3) Demo healthyspace: marca algunos destacados y siembra foto/descripción de
--     cada sede para que la sección se vea.
-- Todo editable desde admin (Fase 3). Gyms de 1 sede: sin sección Sucursales.
-- ============================================================================

ALTER TABLE recursos     ADD COLUMN IF NOT EXISTS destacado boolean NOT NULL DEFAULT false;
ALTER TABLE instructores ADD COLUMN IF NOT EXISTS destacado boolean NOT NULL DEFAULT false;
ALTER TABLE sucursales   ADD COLUMN IF NOT EXISTS foto_url text;
ALTER TABLE sucursales   ADD COLUMN IF NOT EXISTS descripcion text;

COMMENT ON COLUMN recursos.destacado IS
  'Sala destacada en la landing pública. Si ninguna está marcada, la landing muestra todas (cap). Editable en admin → Recursos.';
COMMENT ON COLUMN instructores.destacado IS
  'Instructor destacado en la landing pública. Editable en admin → Instructores.';
COMMENT ON COLUMN sucursales.foto_url IS
  'Foto de la sede para la sección "Sucursales" de la landing. Editable en admin → Sucursales.';
COMMENT ON COLUMN sucursales.descripcion IS
  'Descripción corta de la sede para la sección "Sucursales". Editable en admin → Sucursales.';

-- ----------------------------------------------------------------------------
-- DEMO healthyspace
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  IF v_tenant IS NULL THEN RETURN; END IF;

  -- Foto + descripción de cada sede (foto = una foto de una sala de esa sede).
  UPDATE sucursales s
  SET
    descripcion = COALESCE(s.descripcion, 'Clases boutique, salas equipadas y un equipo que te acompaña en cada sesión.'),
    foto_url = COALESCE(s.foto_url, (
      SELECT r.foto_url FROM recursos r
      WHERE r.sucursal_id = s.id AND r.foto_url IS NOT NULL AND r.activo
      ORDER BY r.orden ASC, r.created_at ASC
      LIMIT 1
    ))
  WHERE s.tenant_id = v_tenant;

  -- Destacar las primeras ~4 salas y ~4 instructores (por orden) → curación visible.
  UPDATE recursos SET destacado = true
  WHERE id IN (
    SELECT id FROM recursos WHERE tenant_id = v_tenant AND activo
    ORDER BY orden ASC, created_at ASC LIMIT 4
  );
  UPDATE instructores SET destacado = true
  WHERE id IN (
    SELECT id FROM instructores WHERE tenant_id = v_tenant AND activo
    ORDER BY orden ASC, created_at ASC LIMIT 4
  );
END $$;
