-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Cobrar inscripción a un socio a criterio de recepción (aunque ya figure como socio)
-- ----------------------------------------------------------------------------
-- La regla "inscripción solo al socio nuevo" (20260819150000) hace que a quien ya tuvo
-- CUALQUIER membresía (activa, vencida o incluso cancelada) NO se le ofrezca cobrar
-- inscripción. Correcto para no re-cobrar a quien entró en periodo gratis. Pero a veces
-- SÍ se le quiere cobrar: p.ej. una socia con plan activo que nunca pagó inscripción, o
-- una a la que le cancelaron el plan por error y hay que reactivarla CON inscripción
-- (casos Paola y Estephany en numa).
--
-- Este RPC cobra la inscripción a criterio de staff: registra el pago en la Caja y marca
-- `usuarios.inscripcion_pagada_at`. Complementa a `exentar_inscripcion_socio` (lo inverso).
-- El monto sale del tier de su membresía más reciente (o se pasa explícito). No permite
-- doble cobro (si ya está pagada/exenta, falla).
-- ============================================================================

CREATE OR REPLACE FUNCTION cobrar_inscripcion_socio(
  p_usuario_id uuid,
  p_metodo text,
  p_monto_centavos integer DEFAULT NULL,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_socio usuarios;
  v_mem_id uuid;
  v_tier_id uuid;
  v_sucursal uuid;
  v_monto integer;
  v_moneda text;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo staff (admin/recepción) puede cobrar inscripción';
  END IF;
  IF p_metodo NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: usa efectivo, tarjeta o transferencia';
  END IF;

  v_tenant := get_my_tenant_id();

  SELECT * INTO v_socio FROM usuarios
  WHERE id = p_usuario_id AND tenant_id = v_tenant AND rol = 'miembro';
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: el socio no existe en tu gimnasio';
  END IF;
  IF v_socio.inscripcion_pagada_at IS NOT NULL THEN
    RAISE EXCEPTION 'INSCRIPCION_YA_PAGADA: este socio ya tiene la inscripción registrada';
  END IF;

  -- Membresía más reciente: de ahí salen tier, sede, monto y moneda (o se pasa monto).
  SELECT m.id, m.tier_id, m.sucursal_id,
         COALESCE(p_monto_centavos, t.inscripcion_centavos, 0),
         COALESCE(t.moneda, 'MXN')
  INTO v_mem_id, v_tier_id, v_sucursal, v_monto, v_moneda
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id AND m.tenant_id = v_tenant
  ORDER BY m.created_at DESC
  LIMIT 1;

  -- Sin membresía → usa el monto explícito (si lo dan).
  IF v_mem_id IS NULL THEN
    v_monto := COALESCE(p_monto_centavos, 0);
    v_moneda := 'MXN';
  END IF;

  IF COALESCE(v_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'SIN_MONTO: el plan no tiene inscripción configurada; indica el monto a cobrar';
  END IF;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
    concepto, monto_centavos, moneda, metodo, notas, cobrado_por
  ) VALUES (
    v_tenant, v_sucursal, p_usuario_id, v_mem_id, v_tier_id,
    'inscripcion', v_monto, v_moneda, p_metodo,
    COALESCE(NULLIF(trim(p_motivo), ''), 'inscripción (cobro manual)'), get_my_user_id()
  );

  UPDATE usuarios SET inscripcion_pagada_at = now() WHERE id = p_usuario_id;

  RETURN jsonb_build_object('ok', true, 'monto_centavos', v_monto, 'moneda', v_moneda);
END;
$$;

REVOKE ALL ON FUNCTION cobrar_inscripcion_socio(uuid, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cobrar_inscripcion_socio(uuid, text, integer, text) TO authenticated;


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) socio sin inscripción + membresía con tier de inscripción → cobra y marca fecha.
--   2) volver a cobrar → falla (INSCRIPCION_YA_PAGADA), sin doble cobro.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_cobrar_inscripcion()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_admin uuid; v_socio uuid; v_tier uuid;
  v_slug text := 'zz-test-cobins-' || substr(md5(random()::text), 1, 6);
  v_cobros int; v_fecha timestamptz; v_r text; v_ok2 text := '(no corrió)';
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test cobrar insc', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data,
                          encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          v_slug || '-admin@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
          '', now(), now(), now());
  UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = v_auth RETURNING id INTO v_admin;

  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, inscripcion_centavos, activo, orden)
  VALUES (v_tenant, 'elevate', 'Plan Elevate', 140000, 'MXN', 'mensual', 'tiempo', NULL, 30, 40000, true, 1)
  RETURNING id INTO v_tier;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug||'-s@x.dev', 'Socia', 'miembro', 'activo') RETURNING id INTO v_socio;

  -- Membresía directa (activa) SIN pasar por el motor → no cobra inscripción, queda NULL.
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- 1) Cobrar inscripción.
  PERFORM cobrar_inscripcion_socio(v_socio, 'tarjeta', NULL, 'inscripción manual');
  SELECT count(*) INTO v_cobros FROM pagos WHERE usuario_id = v_socio AND concepto = 'inscripcion';
  SELECT inscripcion_pagada_at INTO v_fecha FROM usuarios WHERE id = v_socio;

  -- 2) Segundo intento → debe fallar.
  BEGIN
    PERFORM cobrar_inscripcion_socio(v_socio, 'efectivo', NULL, NULL);
    v_ok2 := '❌ dejó cobrar dos veces';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_r = MESSAGE_TEXT;
    v_ok2 := CASE WHEN v_r LIKE 'INSCRIPCION_YA_PAGADA%' THEN '✅ bloqueó doble cobro' ELSE '⚠ otro: ' || v_r END;
  END;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);

  prueba := '1. cobra inscripción (1 pago + fecha marcada)';
  resultado := CASE WHEN v_cobros = 1 AND v_fecha IS NOT NULL
    THEN '✅ 1 pago de $400 y fecha marcada'
    ELSE '❌ pagos=' || v_cobros || ' fecha=' || COALESCE(v_fecha::text,'NULL') END; RETURN NEXT;
  prueba := '2. segundo cobro → bloqueado';
  resultado := v_ok2; RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_cobrar_inscripcion();
DROP FUNCTION _diag_cobrar_inscripcion();
