-- ============================================================================
-- FIX #7 — desactivar el rol 'staff' (rol a medias, sin UI propia).
-- ----------------------------------------------------------------------------
-- 'staff' era creable (dropdowns + admin-create-user/admin-update-role) pero no
-- tenía superficie propia: al loguear caía en la app de MIEMBRO (sin membresía
-- → dashboard roto). El backend le daba permisos parciales (los RPCs de check-in
-- aceptan staff; los de gestión de socios exigen recepcionista/admin), pero esa
-- UI parcial nunca se construyó.
--
-- Decisión: desactivar el rol hasta diseñarlo bien. La creación se bloquea en el
-- frontend + ROLES_VALIDOS de las Netlify functions. Acá normalizamos cualquier
-- staff EXISTENTE → recepcionista (casa funcional: recepcionista ya hace check-in
-- y gestión de socios). Dejamos 'staff' en el CHECK del rol por compatibilidad
-- (no rompe datos/FKs históricos); simplemente ya no se asigna.
-- ============================================================================

DO $$
DECLARE
  v_n integer;
  v_left integer;
BEGIN
  UPDATE usuarios
  SET rol = 'recepcionista', updated_at = now()
  WHERE rol = 'staff';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'FIX #7: % usuario(s) con rol staff → recepcionista.', v_n;

  SELECT count(*) INTO v_left FROM usuarios WHERE rol = 'staff';
  IF v_left > 0 THEN
    RAISE EXCEPTION 'FIX #7 FALLO: quedan % usuarios con rol staff.', v_left;
  END IF;
  RAISE NOTICE 'FIX #7 OK: no quedan usuarios con rol staff.';
END $$;
