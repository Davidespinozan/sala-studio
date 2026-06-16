-- ============================================================================
-- Demo con sesión ANÓNIMA: provisión del visitante.
-- ----------------------------------------------------------------------------
-- El visitante hace anonymous sign-in y llama a este RPC con la vista elegida
-- (admin / miembro / recepcionista). Le crea una fila en `usuarios` dentro de
-- sala-demo con ese rol (y, para miembro, una membresía activa para que la app
-- se vea real). Solo usuarios ANÓNIMOS pueden auto-provisionarse, y siempre cae
-- en sala-demo — la RLS + los guardrails lo encierran ahí.
--
-- Setup: activar "Allow anonymous sign-ins" en Supabase (Auth → Providers).
-- ============================================================================

CREATE OR REPLACE FUNCTION provisionar_demo(p_rol text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_anon boolean;
  v_demo uuid;
  v_user uuid;
  v_tier_id uuid;
  v_tier_slug text;
  v_mem uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sin sesión.';
  END IF;
  IF p_rol NOT IN ('admin', 'miembro', 'recepcionista') THEN
    RAISE EXCEPTION 'Rol de demo inválido.';
  END IF;

  -- Solo los usuarios anónimos pueden auto-provisionarse el demo.
  SELECT is_anonymous INTO v_anon FROM auth.users WHERE id = v_uid;
  IF NOT COALESCE(v_anon, false) THEN
    RAISE EXCEPTION 'Solo el demo anónimo puede usar esta función.';
  END IF;

  SELECT id INTO v_demo FROM tenants WHERE slug = 'sala-demo';
  IF v_demo IS NULL THEN
    RAISE EXCEPTION 'sala-demo no existe.';
  END IF;

  -- Fila en usuarios (idempotente). Anon no tiene email → sintetizamos uno único.
  SELECT id INTO v_user FROM usuarios WHERE auth_id = v_uid;
  IF v_user IS NULL THEN
    INSERT INTO usuarios (auth_id, tenant_id, email, nombre, rol, status)
    VALUES (v_uid, v_demo, 'demo-' || v_uid || '@demo.local', 'Visitante demo', p_rol, 'activo')
    RETURNING id INTO v_user;
  ELSE
    UPDATE usuarios SET rol = p_rol, status = 'activo', tenant_id = v_demo WHERE id = v_user;
  END IF;

  -- Miembro: membresía activa en el plan más completo (para mostrar QR/plan).
  IF p_rol = 'miembro' THEN
    SELECT id, slug INTO v_tier_id, v_tier_slug
    FROM tiers WHERE tenant_id = v_demo AND activo = true
    ORDER BY precio_centavos DESC LIMIT 1;

    IF v_tier_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM membresias WHERE usuario_id = v_user AND status = 'activa') THEN
      INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_demo, v_user, v_tier_id, 'activa', now(), now() + interval '365 days')
      RETURNING id INTO v_mem;
      UPDATE usuarios SET membresia_activa_id = v_mem, membresia_tier = v_tier_slug WHERE id = v_user;
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION provisionar_demo(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provisionar_demo(text) TO authenticated;

COMMENT ON FUNCTION provisionar_demo(text) IS
  'Demo anónimo: da al visitante (usuario anónimo) el rol elegido dentro de sala-demo. Solo anónimos; siempre sala-demo.';
