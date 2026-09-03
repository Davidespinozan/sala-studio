-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Exentar la inscripción a un socio (cortesía): marca inscripcion_pagada_at
-- ----------------------------------------------------------------------------
-- Complementa la regla "inscripción solo al socio nuevo" (20260819150000): a veces
-- SÍ quieres perdonarle la inscripción a un socio nuevo (amigo, familia, promo). En
-- vez de tocar el motor grande, un RPC chico marca `inscripcion_pagada_at`; luego el
-- motor (que ya lee ese campo) NO cobra inscripción en el alta. Staff-only, scopeado
-- por tenant. Idempotente: si ya tenía fecha, la respeta.
-- ============================================================================

CREATE OR REPLACE FUNCTION exentar_inscripcion_socio(p_usuario_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo staff (admin/recepción) puede exentar inscripción';
  END IF;

  UPDATE usuarios
  SET inscripcion_pagada_at = COALESCE(inscripcion_pagada_at, now())
  WHERE id = p_usuario_id
    AND tenant_id = get_my_tenant_id()
    AND rol = 'miembro';
END;
$$;

REVOKE ALL ON FUNCTION exentar_inscripcion_socio(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION exentar_inscripcion_socio(uuid) TO authenticated;

-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA. Exentar deja inscripcion_pagada_at != NULL, y luego el
-- motor NO cobra inscripción aunque el tier la tenga.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_exentar_inscripcion()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_admin uuid; v_socio uuid; v_con uuid;
  v_slug text := 'zz-test-exon-' || substr(md5(random()::text), 1, 6);
  v_fecha timestamptz; v_ins int;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test exención', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data,
                          encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          v_slug || '-admin@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
          '', now(), now(), now());
  UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = v_auth RETURNING id INTO v_admin;

  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, inscripcion_centavos, activo, orden)
  VALUES (v_tenant, 'con-insc', 'Con inscripción', 80000, 'MXN', 'mensual', 'tiempo', NULL, 30, 50000, true, 1)
  RETURNING id INTO v_con;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug||'-s@x.dev', 'Socio', 'miembro', 'activo') RETURNING id INTO v_socio;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- Exentar → deja fecha.
  PERFORM exentar_inscripcion_socio(v_socio);
  SELECT inscripcion_pagada_at INTO v_fecha FROM usuarios WHERE id = v_socio;

  -- Alta con tier de inscripción → NO cobra (porque quedó exento).
  PERFORM gestionar_membresia_socio(v_socio, v_con, 'alta cortesía inscripción', 'efectivo', 80000);
  SELECT count(*) INTO v_ins FROM pagos WHERE usuario_id = v_socio AND concepto = 'inscripcion';

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);

  prueba := '1. exentar deja inscripcion_pagada_at';
  resultado := CASE WHEN v_fecha IS NOT NULL THEN '✅ marcada' ELSE '❌ NULL' END; RETURN NEXT;
  prueba := '2. socio exento + alta con inscripción → NO cobra';
  resultado := CASE WHEN v_ins = 0 THEN '✅ no cobró' ELSE '❌ cobró (' || v_ins || ')' END; RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_exentar_inscripcion();
DROP FUNCTION _diag_exentar_inscripcion();
