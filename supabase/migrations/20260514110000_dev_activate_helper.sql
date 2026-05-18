-- ============================================================================
-- DEV HELPER: activar miembros manualmente sin pasar por Stripe
-- ============================================================================
-- En producción NO se usa. Solo durante desarrollo, hasta que onboarding +
-- Stripe esté listo. Se elimina cuando el flow real esté integrado.
-- ============================================================================

CREATE OR REPLACE FUNCTION dev_activar_miembro(p_email text, p_tier text DEFAULT 'pro')
RETURNS usuarios
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usuario usuarios;
BEGIN
  UPDATE usuarios
  SET status = 'activo',
      membresia_tier = p_tier
  WHERE lower(email) = lower(p_email)
  RETURNING * INTO v_usuario;

  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'Usuario % no encontrado', p_email;
  END IF;

  RETURN v_usuario;
END;
$$;

COMMENT ON FUNCTION dev_activar_miembro IS
  'DEV ONLY: activa un miembro saltándose Stripe. Eliminar cuando exista onboarding real.';
