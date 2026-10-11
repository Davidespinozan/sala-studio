-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref `omrlbvhbggnrwwzlgxji`
-- ============================================================================
-- TESTS — descuentos por socio (self-tests que DEVUELVEN UNA TABLA)
-- ----------------------------------------------------------------------------
-- Correr DESPUÉS de 20261011100000_descuentos_por_socio.sql.
-- Cada bloque arma su escenario sobre healthyspace (demo) en una
-- subtransacción y la revierte con un centinela (RAISE 'RB_*'). NO persiste
-- nada. Resultados: OK / SKIP (...) / FAIL: ... / ERROR: ...
--
-- 1 y 4 crean su PROPIO socio y su propio paquete (con inscripción) dentro de
-- la subtransacción: el demo solo tiene mensualidades y ningún socio sin
-- membresía, así que con datos existentes se saltaban.
--
-- Cubre: 1) otorgar + precio con 20% (y la app no rebaja mensualidades)
--        2) vencido → precio de lista
--        3) un socio no puede otorgarse el descuento
--        4) el cobro en recepción registra el monto rebajado y la inscripción
--           (si la hay) completa
--        5) un admin no puede otorgar a un socio de OTRO gym
-- ============================================================================

DROP TABLE IF EXISTS _ds_test_results;
CREATE TEMP TABLE _ds_test_results (orden int, test text, resultado text);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Otorgar + precio
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_res text := 'SKIP (sin healthyspace/admin)';
  v_tenant uuid; v_admin RECORD; v_socio uuid; v_tier RECORD; v_tier_mes RECORD;
  v_d uuid; v_p jsonb; v_esperado integer; v_out jsonb;
  v_sfx text := substr(gen_random_uuid()::text, 1, 8);
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT id, auth_id INTO v_admin FROM usuarios
    WHERE tenant_id = v_tenant AND rol = 'admin' AND status = 'activo' AND auth_id IS NOT NULL LIMIT 1;

  IF v_tenant IS NOT NULL AND v_admin.id IS NOT NULL THEN
    BEGIN
      INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
      VALUES (v_tenant, 'desc-test-' || v_sfx || '@sala.dev', 'TEST descuento', 'miembro', 'activo')
      RETURNING id INTO v_socio;
      INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, clases_incluidas, activo, orden)
      VALUES (v_tenant, 'desc-paq-' || v_sfx, 'TEST paquete', 'hibrido', 135000, 'MXN', 30, 8, true, 999)
      RETURNING id, precio_centavos INTO v_tier;
      INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, activo, orden)
      VALUES (v_tenant, 'desc-mes-' || v_sfx, 'TEST mensualidad', 'tiempo', 100000, 'MXN', 30, true, 999)
      RETURNING id, precio_centavos INTO v_tier_mes;
      INSERT INTO descuentos (tenant_id, nombre, porcentaje, vigencia_meses)
      VALUES (v_tenant, 'TEST estudiante ' || v_sfx, 20, 6)
      RETURNING id INTO v_d;

      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin.auth_id::text)::text, true);
      PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_tenant::text)::text, true);
      v_out := otorgar_descuento_socio(v_socio, v_d);

      v_p := _precio_plan_para_socio(v_socio, v_tier.id, 'recepcion');
      v_esperado := v_tier.precio_centavos - round(v_tier.precio_centavos * 20 / 100.0)::integer;

      IF (v_out->>'vence_el') IS NULL THEN
        v_res := 'FAIL: otorgar no devolvió vence_el ' || v_out::text;
      ELSIF (v_p->>'precio_final_centavos')::integer <> v_esperado THEN
        v_res := format('FAIL: precio final %s, se esperaba %s', v_p->>'precio_final_centavos', v_esperado);
      ELSIF (v_p->>'etiqueta') IS NULL THEN
        v_res := 'FAIL: sin etiqueta';
      ELSIF (_precio_plan_para_socio(v_socio, v_tier.id, 'app')->>'precio_final_centavos')::integer <> v_esperado THEN
        v_res := 'FAIL: la app no rebaja el paquete';
      ELSIF (_precio_plan_para_socio(v_socio, v_tier_mes.id, 'app')->>'descuento_centavos')::integer <> 0 THEN
        v_res := 'FAIL: la app rebajó una mensualidad';
      ELSIF (_precio_plan_para_socio(v_socio, v_tier_mes.id, 'recepcion')->>'descuento_centavos')::integer <> 20000 THEN
        v_res := 'FAIL: recepción no rebajó la mensualidad';
      ELSIF jsonb_array_length(precios_planes_para_socio(v_socio, 'recepcion')) = 0 THEN
        v_res := 'FAIL: precios_planes_para_socio vacío';
      ELSE
        v_res := 'OK';
      END IF;
      RAISE EXCEPTION 'RB_1';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'RB_1' THEN v_res := 'ERROR: ' || SQLERRM; END IF;
    END;
  END IF;
  INSERT INTO _ds_test_results VALUES (1, 'otorgar-y-precio', v_res);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Vencido → precio de lista
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_res text := 'SKIP (sin healthyspace/socio/plan con precio)';
  v_tenant uuid; v_socio uuid; v_tier RECORD; v_d uuid; v_p jsonb;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT id INTO v_socio FROM usuarios WHERE tenant_id = v_tenant AND rol = 'miembro' LIMIT 1;
  SELECT id, precio_centavos INTO v_tier FROM tiers
    WHERE tenant_id = v_tenant AND activo AND precio_centavos > 0
      AND NOT COALESCE(es_pase, false) AND NOT COALESCE(es_prueba, false) LIMIT 1;

  IF v_tenant IS NOT NULL AND v_socio IS NOT NULL AND v_tier.id IS NOT NULL THEN
    BEGIN
      INSERT INTO descuentos (tenant_id, nombre, porcentaje)
      VALUES (v_tenant, 'TEST vencido ' || substr(gen_random_uuid()::text, 1, 8), 20)
      RETURNING id INTO v_d;
      DELETE FROM socio_descuentos WHERE usuario_id = v_socio;
      -- Dos días atrás: vencido en cualquier zona horaria.
      INSERT INTO socio_descuentos (tenant_id, usuario_id, descuento_id, vence_el)
      VALUES (v_tenant, v_socio, v_d, (now() - interval '2 days')::date);

      v_p := _precio_plan_para_socio(v_socio, v_tier.id, 'recepcion');
      IF (v_p->>'precio_final_centavos')::integer <> v_tier.precio_centavos THEN
        v_res := 'FAIL: vencido y aun así rebajó a ' || (v_p->>'precio_final_centavos');
      ELSIF (v_p->>'etiqueta') IS NOT NULL THEN
        v_res := 'FAIL: vencido y trae etiqueta';
      ELSE
        v_res := 'OK';
      END IF;
      RAISE EXCEPTION 'RB_2';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'RB_2' THEN v_res := 'ERROR: ' || SQLERRM; END IF;
    END;
  END IF;
  INSERT INTO _ds_test_results VALUES (2, 'vencido-precio-de-lista', v_res);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Un socio no puede otorgarse el descuento
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_res text := 'SKIP (sin healthyspace/socio con login)';
  v_tenant uuid; v_socio RECORD; v_d uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT id, auth_id INTO v_socio FROM usuarios
    WHERE tenant_id = v_tenant AND rol = 'miembro' AND status = 'activo' AND auth_id IS NOT NULL LIMIT 1;

  IF v_tenant IS NOT NULL AND v_socio.id IS NOT NULL THEN
    BEGIN
      INSERT INTO descuentos (tenant_id, nombre, porcentaje)
      VALUES (v_tenant, 'TEST socio ' || substr(gen_random_uuid()::text, 1, 8), 20)
      RETURNING id INTO v_d;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_socio.auth_id::text)::text, true);
      PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_tenant::text)::text, true);
      PERFORM otorgar_descuento_socio(v_socio.id, v_d);
      v_res := 'FAIL: un socio se otorgó el descuento';
      RAISE EXCEPTION 'RB_3';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'NO_AUTORIZADO%' THEN v_res := 'OK';
      ELSIF SQLERRM <> 'RB_3' THEN v_res := 'ERROR: ' || SQLERRM; END IF;
    END;
  END IF;
  INSERT INTO _ds_test_results VALUES (3, 'socio-no-se-lo-otorga', v_res);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) El cobro en recepción registra el monto rebajado
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_res text := 'SKIP (sin healthyspace/admin)';
  v_tenant uuid; v_admin RECORD; v_socio uuid; v_tier RECORD;
  v_d uuid; v_out jsonb; v_esperado integer; v_pago RECORD; v_insc RECORD;
  v_sfx text := substr(gen_random_uuid()::text, 1, 8);
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT id, auth_id INTO v_admin FROM usuarios
    WHERE tenant_id = v_tenant AND rol = 'admin' AND status = 'activo' AND auth_id IS NOT NULL LIMIT 1;

  IF v_tenant IS NOT NULL AND v_admin.id IS NOT NULL THEN
    BEGIN
      -- Socio nuevo SIN membresía: alta limpia → cobra plan (rebajado) + inscripción (completa).
      INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
      VALUES (v_tenant, 'desc-cobro-' || v_sfx || '@sala.dev', 'TEST cobro', 'miembro', 'activo')
      RETURNING id INTO v_socio;
      INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, clases_incluidas, inscripcion_centavos, activo, orden)
      VALUES (v_tenant, 'desc-cobro-' || v_sfx, 'TEST paquete', 'hibrido', 135000, 'MXN', 30, 8, 50000, true, 999)
      RETURNING id, precio_centavos, inscripcion_centavos INTO v_tier;
      INSERT INTO descuentos (tenant_id, nombre, porcentaje)
      VALUES (v_tenant, 'TEST cobro ' || v_sfx, 20)
      RETURNING id INTO v_d;

      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin.auth_id::text)::text, true);
      PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_tenant::text)::text, true);
      PERFORM otorgar_descuento_socio(v_socio, v_d);
      v_out := gestionar_membresia_socio(v_socio, v_tier.id, 'TEST descuento', 'efectivo');

      v_esperado := v_tier.precio_centavos - round(v_tier.precio_centavos * 20 / 100.0)::integer;
      SELECT monto_centavos, notas INTO v_pago FROM pagos
        WHERE usuario_id = v_socio AND tier_id = v_tier.id AND concepto IN ('plan', 'paquete')
        ORDER BY created_at DESC LIMIT 1;
      SELECT monto_centavos INTO v_insc FROM pagos
        WHERE usuario_id = v_socio AND tier_id = v_tier.id AND concepto = 'inscripcion'
        ORDER BY created_at DESC LIMIT 1;

      IF v_pago.monto_centavos IS DISTINCT FROM v_esperado THEN
        v_res := format('FAIL: pago del plan %s, se esperaba %s', v_pago.monto_centavos, v_esperado);
      ELSIF v_pago.notas NOT LIKE '%-20%%' THEN
        v_res := 'FAIL: la nota del pago no trae el descuento: ' || COALESCE(v_pago.notas, 'NULL');
      ELSIF (v_out->>'descuento_centavos')::integer <> v_tier.precio_centavos - v_esperado THEN
        v_res := 'FAIL: respuesta sin descuento_centavos correcto ' || v_out::text;
      ELSIF v_insc.monto_centavos IS DISTINCT FROM v_tier.inscripcion_centavos THEN
        v_res := format('FAIL: inscripción %s, se esperaba completa %s', v_insc.monto_centavos, v_tier.inscripcion_centavos);
      ELSE
        v_res := 'OK';
      END IF;
      RAISE EXCEPTION 'RB_4';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'RB_4' THEN v_res := 'ERROR: ' || SQLERRM; END IF;
    END;
  END IF;
  INSERT INTO _ds_test_results VALUES (4, 'cobro-recepcion-rebajado', v_res);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Cross-tenant
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_res text := 'SKIP (sin healthyspace/admin/socio de otro gym)';
  v_tenant uuid; v_auth uuid; v_ajeno uuid; v_d uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT auth_id INTO v_auth FROM usuarios
    WHERE tenant_id = v_tenant AND rol = 'admin' AND status = 'activo' AND auth_id IS NOT NULL LIMIT 1;
  SELECT id INTO v_ajeno FROM usuarios WHERE tenant_id <> v_tenant AND rol = 'miembro' LIMIT 1;

  IF v_tenant IS NOT NULL AND v_auth IS NOT NULL AND v_ajeno IS NOT NULL THEN
    BEGIN
      INSERT INTO descuentos (tenant_id, nombre, porcentaje)
      VALUES (v_tenant, 'TEST ajeno ' || substr(gen_random_uuid()::text, 1, 8), 20)
      RETURNING id INTO v_d;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
      PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_tenant::text)::text, true);
      PERFORM otorgar_descuento_socio(v_ajeno, v_d);
      v_res := 'FAIL: otorgó a un socio de otro gym';
      RAISE EXCEPTION 'RB_5';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SOCIO_NO_EXISTE%' THEN v_res := 'OK';
      ELSIF SQLERRM <> 'RB_5' THEN v_res := 'ERROR: ' || SQLERRM; END IF;
    END;
  END IF;
  INSERT INTO _ds_test_results VALUES (5, 'cross-tenant-rechazado', v_res);
END $$;

SELECT test, resultado FROM _ds_test_results ORDER BY orden;
