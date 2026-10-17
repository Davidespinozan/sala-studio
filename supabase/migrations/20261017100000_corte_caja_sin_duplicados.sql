-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref `omrlbvhbggnrwwzlgxji`
-- ════════════════════════════════════════════════════════════════════════════
-- CORTE DE CAJA: el mismo periodo no se asienta dos veces (CORTE_DUPLICADO).
-- ────────────────────────────────────────────────────────────────────────────
-- numa (oct 2026) llegó a tener 8 cortes matutinos idénticos en 12 minutos: la
-- recepción confirmaba otra vez porque no veía la confirmación. Un corte es un
-- reporte de un periodo; dos cortes con EXACTAMENTE el mismo (sede, desde,
-- hasta) son el mismo reporte. El RPC ahora lo rechaza con un código que la UI
-- traduce ("Ese corte ya está hecho"). Periodos que se enciman parcialmente
-- siguen permitidos (ya se avisa en la UI).
--
-- Cuerpo = 20261005260000 (guard de sede + lock W2-02 + resumen) + el freno.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.hacer_corte_caja(
  p_desde timestamp with time zone,
  p_hasta timestamp with time zone,
  p_sucursal_id uuid DEFAULT NULL::uuid,
  p_efectivo_contado_centavos integer DEFAULT 0,
  p_fondo_centavos integer DEFAULT 0,
  p_notas text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid; v_actor uuid;
  v_esperado integer; v_dif integer; v_id uuid; v_resumen jsonb;
BEGIN
  IF NOT is_recepcionista() THEN RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin'; END IF;
  v_tenant := get_my_tenant_id();
  v_actor  := get_my_user_id();

  IF p_efectivo_contado_centavos < 0 OR p_fondo_centavos < 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: los montos no pueden ser negativos';
  END IF;
  IF p_hasta <= p_desde THEN
    RAISE EXCEPTION 'RANGO_INVALIDO: la fecha final debe ser mayor que la inicial';
  END IF;
  IF p_sucursal_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'SUCURSAL_INVALIDA';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion_param(p_sucursal_id);

  -- W2-02: serializa el corte por TENANT (ver 20260928130000). También hace que
  -- el chequeo de duplicado de abajo sea seguro ante dos clics simultáneos.
  PERFORM pg_advisory_xact_lock(hashtext('corte:' || v_tenant::text));

  -- Mismo periodo, misma sede → es el mismo corte. No se repite.
  IF EXISTS (
    SELECT 1 FROM cortes_caja
     WHERE tenant_id = v_tenant
       AND sucursal_id IS NOT DISTINCT FROM p_sucursal_id
       AND desde = p_desde AND hasta = p_hasta
  ) THEN
    RAISE EXCEPTION 'CORTE_DUPLICADO: ya existe un corte con exactamente este periodo';
  END IF;

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_esperado FROM pagos
   WHERE tenant_id = v_tenant AND metodo = 'efectivo'
     AND (p_sucursal_id IS NULL OR sucursal_id = p_sucursal_id)
     AND created_at >= p_desde AND created_at < p_hasta;

  v_dif := p_efectivo_contado_centavos - (v_esperado + p_fondo_centavos);
  v_resumen := _resumen_corte(v_tenant, p_sucursal_id, p_desde, p_hasta);

  INSERT INTO cortes_caja (
    tenant_id, sucursal_id, realizado_por, desde, hasta,
    efectivo_esperado_centavos, fondo_centavos, efectivo_contado_centavos, diferencia_centavos, notas, resumen
  ) VALUES (
    v_tenant, p_sucursal_id, v_actor, p_desde, p_hasta,
    v_esperado, p_fondo_centavos, p_efectivo_contado_centavos, v_dif, NULLIF(trim(p_notas), ''), v_resumen
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true, 'id', v_id, 'desde', p_desde, 'hasta', p_hasta,
    'efectivo_esperado_centavos', v_esperado, 'fondo_centavos', p_fondo_centavos,
    'efectivo_contado_centavos', p_efectivo_contado_centavos, 'diferencia_centavos', v_dif,
    'resumen', v_resumen
  );
END; $function$;

REVOKE ALL ON FUNCTION hacer_corte_caja(timestamptz, timestamptz, uuid, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hacer_corte_caja(timestamptz, timestamptz, uuid, integer, integer, text) TO authenticated;

-- ── Self-test (devuelve TABLA; tenant desechable que se cierra al final) ─────
CREATE OR REPLACE FUNCTION _diag_corte_duplicado()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_slug text := 'zz-cortedup-' || substr(md5(random()::text), 1, 6);
  v_t uuid; a_admin uuid := gen_random_uuid();
  v_desde timestamptz := date_trunc('day', now());
  v_hasta timestamptz := date_trunc('day', now()) + interval '12 hours';
  v_err text; v_n int;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug, 'Corte dup', 'gym_libre', 'activo') RETURNING id INTO v_t;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (a_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-ad@sala.dev',
          jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'), '', now(), now(), now());
  UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = a_admin;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', a_admin::text)::text, true);

  v_err := NULL;
  BEGIN PERFORM hacer_corte_caja(v_desde, v_hasta, NULL, 0, 0, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  prueba := 'T1. primer corte del periodo → ALLOW';
  resultado := CASE WHEN v_err IS NULL THEN '✅ ok' ELSE '❌ ' || v_err END;
  RETURN NEXT;

  v_err := NULL;
  BEGIN PERFORM hacer_corte_caja(v_desde, v_hasta, NULL, 0, 0, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  SELECT count(*) INTO v_n FROM cortes_caja WHERE tenant_id = v_t;
  prueba := 'T2. mismo periodo otra vez → CORTE_DUPLICADO y sigue habiendo 1';
  resultado := CASE WHEN v_err LIKE 'CORTE_DUPLICADO%' AND v_n = 1 THEN '✅ ok' ELSE '❌ err=' || coalesce(v_err, '(ninguno)') || ' n=' || v_n END;
  RETURN NEXT;

  v_err := NULL;
  BEGIN PERFORM hacer_corte_caja(v_hasta, v_hasta + interval '8 hours', NULL, 0, 0, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  prueba := 'T3. otro periodo (vespertino) → ALLOW';
  resultado := CASE WHEN v_err IS NULL THEN '✅ ok' ELSE '❌ ' || v_err END;
  RETURN NEXT;

  v_err := NULL;
  BEGIN PERFORM hacer_corte_caja(v_desde, v_hasta + interval '12 hours', NULL, 0, 0, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  prueba := 'T4. periodo que se ENCIMA pero no es idéntico (día completo) → ALLOW';
  resultado := CASE WHEN v_err IS NULL THEN '✅ ok' ELSE '❌ ' || v_err END;
  RETURN NEXT;

  prueba := 'T5. lock W2-02 sigue en el cuerpo';
  resultado := CASE WHEN (SELECT position('pg_advisory_xact_lock' IN prosrc) > 0 FROM pg_proc WHERE proname = 'hacer_corte_caja') THEN '✅ ok' ELSE '❌ lock perdido' END;
  RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
  RETURN;
END $$;

SELECT * FROM _diag_corte_duplicado();
DROP FUNCTION _diag_corte_duplicado();
