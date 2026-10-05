-- ============================================================================
-- W6-D — SUPERFICIES DE OPERADOR (observabilidad, read-only)
-- ----------------------------------------------------------------------------
-- No repara nada. No reconcilia automáticamente. No expone payloads crudos del
-- inbox. Dos piezas:
--
--  (1) `stripe_salud_operador(dias)` — RPC de solo lectura, tenant-scoped (el
--      tenant se resuelve DENTRO con get_my_tenant_id(), nunca se acepta del
--      cliente), admin-gated, que agrega conteos de stripe_event_inbox
--      (failed/dead) + stripe_disputas (por estado) + reembolsos (de `pagos`)
--      de los últimos N días. El frontend la llama directo (supabase.rpc),
--      sin Netlify Function nueva: ya cumple admin-gate + tenant-isolation +
--      mínimo privilegio sin infraestructura redundante.
--
--  (2) `stripe_procesar_socio` (follow-up de 20261004120000, que queda
--      intacta): el dispatcher ahora devuelve si hubo una compensación NUEVA
--      (reembolso) o una transición real de estado (disputa resuelta), para
--      que el webhook pueda notificar al staff SIN duplicar aviso cuando
--      Stripe reentrega el mismo evento/objeto. Comportamiento económico
--      IDÉNTICO a C1b — solo se agregan campos informativos al jsonb de
--      retorno, nada cambia en qué se compensa o cuánto.
--
-- Aditiva. No crea tablas ni columnas. service_role/admin-gated-SECURITY
-- DEFINER, igual que reconciliar_verdad_interna (C2). Rollback: CREATE OR
-- REPLACE de vuelta al texto de 20261004120000 (stripe_procesar_socio) + DROP
-- FUNCTION stripe_salud_operador.
-- ============================================================================
BEGIN;

-- ── (1) Resumen de salud, solo lectura, tenant-scoped, admin-gated ─────────
CREATE OR REPLACE FUNCTION stripe_salud_operador(p_dias integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_desde timestamptz;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'SALUD_NO_ADMIN: solo un administrador puede ver la salud de Stripe';
  END IF;
  v_tenant := get_my_tenant_id();        -- SIEMPRE del lado servidor; nunca p_tenant_id del cliente
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'SALUD_SIN_TENANT'; END IF;
  v_desde := now() - (GREATEST(COALESCE(p_dias, 30), 1) || ' days')::interval;

  RETURN jsonb_build_object(
    'tenant_id', v_tenant,
    'desde', v_desde,
    'eventos_fallidos', (
      SELECT count(*) FROM stripe_event_inbox
      WHERE tenant_id = v_tenant AND estado = 'failed' AND updated_at >= v_desde),
    'eventos_dead', (
      SELECT count(*) FROM stripe_event_inbox
      WHERE tenant_id = v_tenant AND estado = 'dead' AND updated_at >= v_desde),
    'disputas_abiertas', (
      SELECT count(*) FROM stripe_disputas
      WHERE tenant_id = v_tenant AND estado = 'abierta' AND creado_en >= v_desde),
    'disputas_perdidas', (
      SELECT count(*) FROM stripe_disputas
      WHERE tenant_id = v_tenant AND estado = 'perdida' AND actualizado_en >= v_desde),
    'disputas_ganadas', (
      SELECT count(*) FROM stripe_disputas
      WHERE tenant_id = v_tenant AND estado = 'ganada' AND actualizado_en >= v_desde),
    'refunds_count', (
      SELECT count(*) FROM pagos
      WHERE tenant_id = v_tenant AND concepto = 'reembolso' AND metodo = 'stripe' AND created_at >= v_desde),
    'refunds_centavos', (
      SELECT COALESCE(SUM(-monto_centavos), 0) FROM pagos
      WHERE tenant_id = v_tenant AND concepto = 'reembolso' AND metodo = 'stripe' AND created_at >= v_desde)
  );
END; $$;

REVOKE ALL ON FUNCTION stripe_salud_operador(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION stripe_salud_operador(integer) TO authenticated, service_role;

COMMENT ON FUNCTION stripe_salud_operador(integer) IS
  'W6-D: resumen de solo lectura (conteos/agregados, sin payloads crudos) de '
  'eventos fallidos/dead, disputas y reembolsos del tenant del admin que '
  'llama. Tenant SIEMPRE resuelto server-side. Sin acceso directo del '
  'cliente a stripe_event_inbox/stripe_disputas.';

-- ── (2) Dispatcher: agrega señal de "¿hubo algo NUEVO que avisar?" ─────────
CREATE OR REPLACE FUNCTION stripe_procesar_socio(p_event_id text, p_kind text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res jsonb; v_rp jsonb; v_tenant uuid; v_ref jsonb;
  v_pagos uuid[]; v_refs text[]; v_sin_pago boolean := false;
  v_compensaciones jsonb := '[]'::jsonb;          -- W6-D: refunds NUEVOS (no idempotentes) de este evento
  v_estado_previo text; v_transicion boolean := false;   -- W6-D: ¿la disputa cambió de estado de verdad?
BEGIN
  IF p_kind = 'activar' THEN
    PERFORM activar_suscripcion_socio(
      (p_args->>'usuario_id')::uuid, (p_args->>'tier_id')::uuid,
      NULLIF(p_args->>'stripe_subscription_id',''), NULLIF(p_args->>'stripe_customer_id',''),
      NULLIF(p_args->>'periodo_fin','')::timestamptz, NULLIF(p_args->>'monto_centavos','')::integer,
      NULLIF(p_args->>'referencia',''), COALESCE(NULLIF(p_args->>'inscripcion_centavos','')::integer,0));

  ELSIF p_kind = 'estado' THEN
    v_res := stripe_aplicar_estado_membresia(
      p_args->>'stripe_subscription_id', p_args->>'nuevo_status',
      (p_args->>'event_created')::timestamptz, p_event_id, NULLIF(p_args->>'account_id',''));
    IF (v_res->>'reason') = 'no_membership' THEN
      RAISE EXCEPTION 'STRIPE_NO_MEMBERSHIP: sub % sin membresía ligada aún', p_args->>'stripe_subscription_id';
    END IF;

  ELSIF p_kind = 'venta_online' THEN
    PERFORM registrar_venta_online(
      (p_args->>'tenant_id')::uuid, (p_args->>'usuario_id')::uuid,
      NULLIF(p_args->>'sucursal_id','')::uuid, p_args->'items',
      p_args->>'referencia', p_args->>'entrega_tipo', NULLIF(p_args->>'entrega_ubicacion',''));

  ELSIF p_kind = 'account' THEN
    UPDATE tenants
    SET stripe_charges_enabled = (p_args->>'charges')::boolean,
        stripe_details_submitted = (p_args->>'details')::boolean
    WHERE stripe_account_id = p_args->>'account_id';

  -- ── REEMBOLSO: por OBJETO Stripe (igual a C1b) + señal de novedad (W6-D). ──
  ELSIF p_kind = 'reembolso' THEN
    v_refs := _stripe_refs_de_args(p_args);
    v_rp := _stripe_resolver_pagos(p_args->>'account_id', v_refs);
    v_tenant := (v_rp->>'tenant')::uuid;
    v_pagos := ARRAY(SELECT jsonb_array_elements_text(v_rp->'pagos'))::uuid[];
    IF cardinality(v_pagos) > 0 THEN
      FOR v_ref IN
        SELECT r FROM jsonb_array_elements(COALESCE(p_args->'refunds','[]'::jsonb)) AS r
        ORDER BY NULLIF(r->>'created','')::bigint NULLS LAST, r->>'refund_id'
      LOOP
        v_res := _stripe_compensar_objeto(v_tenant, v_pagos,
          NULLIF(v_ref->>'amount','')::integer, v_ref->>'refund_id',
          'Reembolso Stripe '||(v_ref->>'refund_id'));
        -- "nuevo" = compensó Y no fue el camino idempotente (replay del mismo refund.id).
        IF COALESCE((v_res->>'compensado')::boolean, false) AND NOT COALESCE((v_res->>'idempotente')::boolean, false) THEN
          v_compensaciones := v_compensaciones || jsonb_build_object(
            'refund_id', v_ref->>'refund_id', 'monto_centavos', (v_res->>'monto_centavos')::integer);
        END IF;
      END LOOP;
    ELSE
      v_sin_pago := true;
    END IF;

  -- ── DISPUTA: igual a C1b + detección de TRANSICIÓN real de estado (W6-D). ──
  ELSIF p_kind = 'disputa' THEN
    v_refs := _stripe_refs_de_args(p_args);
    v_rp := _stripe_resolver_pagos(p_args->>'account_id', v_refs);
    v_tenant := (v_rp->>'tenant')::uuid;
    v_pagos := ARRAY(SELECT jsonb_array_elements_text(v_rp->'pagos'))::uuid[];
    -- estado ANTES de upsertar: si Stripe reentrega el mismo estado, no es noticia.
    SELECT estado INTO v_estado_previo FROM stripe_disputas WHERE tenant_id = v_tenant AND dispute_id = p_args->>'dispute_id';
    v_transicion := (v_estado_previo IS DISTINCT FROM (p_args->>'estado'));
    INSERT INTO stripe_disputas (tenant_id, dispute_id, charge_id, pago_id, estado, monto_centavos, moneda)
    VALUES (v_tenant, p_args->>'dispute_id', NULLIF(p_args->>'charge_id',''), v_pagos[1],
            p_args->>'estado', NULLIF(p_args->>'amount','')::integer, p_args->>'moneda')
    ON CONFLICT (tenant_id, dispute_id) DO UPDATE
      SET estado = EXCLUDED.estado,
          pago_id = COALESCE(stripe_disputas.pago_id, EXCLUDED.pago_id),
          actualizado_en = now();
    IF cardinality(v_pagos) = 0 THEN
      v_sin_pago := true;
    ELSIF p_args->>'estado' = 'perdida' THEN
      v_res := _stripe_compensar_objeto(v_tenant, v_pagos, NULLIF(p_args->>'amount','')::integer,
        'dp_'||(p_args->>'dispute_id'), 'Contracargo Stripe '||(p_args->>'dispute_id'));
      UPDATE stripe_disputas SET compensado = true, actualizado_en = now()
        WHERE tenant_id = v_tenant AND dispute_id = p_args->>'dispute_id';
    END IF;
    -- 'abierta' → solo persiste (el push de "abierta" lo manda el webhook, best-effort, sin cambios).
    -- 'ganada'  → solo actualiza estado; sin compensación.

  ELSIF p_kind = 'sub_estado' THEN
    v_res := stripe_aplicar_estado_membresia(
      p_args->>'stripe_subscription_id', p_args->>'nuevo_status',
      (p_args->>'event_created')::timestamptz, p_event_id, NULLIF(p_args->>'account_id',''));
    IF (v_res->>'reason') = 'no_membership' THEN
      RAISE EXCEPTION 'STRIPE_NO_MEMBERSHIP: sub % (updated) sin membresía ligada aún', p_args->>'stripe_subscription_id';
    END IF;

  ELSE
    RAISE EXCEPTION 'STRIPE_KIND_INVALIDO: %', p_kind;
  END IF;

  PERFORM _stripe_inbox_processed(p_event_id);
  RETURN jsonb_build_object(
    'ok', true, 'kind', p_kind, 'sin_pago', v_sin_pago, 'tenant_id', v_tenant,
    'pago_id', v_pagos[1], 'compensaciones_nuevas', v_compensaciones,
    'dispute_id', p_args->>'dispute_id', 'estado', p_args->>'estado', 'disputa_transicion', v_transicion
  );
END; $$;

-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenant desechable; cerrar_tenant limpia.
-- Llaman al dispatcher DIRECTO (sin pasar por el inbox): no crean filas en
-- stripe_event_inbox, así que no hay residuo que limpiar por account_id.
-- ============================================================================
CREATE TEMP TABLE _w6d_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug text := 'zz-w6d-'||substr(md5(random()::text),1,6);
  v_t uuid; v_u uuid; v_tier uuid; v_mem uuid; v_pago uuid;
  v_r jsonb; v_comp jsonb; v_ok boolean;
BEGIN
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
    VALUES (v_slug,'W6D','gym_libre','activo','acct_w6d','{}'::jsonb) RETURNING id INTO v_t;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t,v_slug||'@x.dev','U','miembro','activo') RETURNING id INTO v_u;
  INSERT INTO tiers (tenant_id,slug,nombre,precio_centavos,tipo,duracion_dias) VALUES (v_t,'w6dt','T',50000,'tiempo',30) RETURNING id INTO v_tier;
  INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,stripe_subscription_id)
    VALUES (v_t,v_u,v_tier,'activa',now()-interval '2 days',now()+interval '28 days','sub_w6d') RETURNING id INTO v_mem;
  INSERT INTO pagos (tenant_id,usuario_id,membresia_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
    VALUES (v_t,v_u,v_mem,v_tier,'plan',50000,'MXN','stripe','cs_w6d') RETURNING id INTO v_pago;

  -- T1: refund NUEVO → compensaciones_nuevas trae el refund_id
  v_r := stripe_procesar_socio('evt_w6d_1','reembolso', jsonb_build_object(
    'account_id','acct_w6d','charge_id','ch_w6d','payment_intent','pi_w6d',
    'refs', jsonb_build_array('ch_w6d','pi_w6d','cs_w6d'),
    'refunds', jsonb_build_array(jsonb_build_object('refund_id','re_w6d_1','amount',20000))));
  v_comp := v_r->'compensaciones_nuevas';
  IF jsonb_array_length(v_comp) <> 1 OR (v_comp->0->>'refund_id') <> 're_w6d_1' THEN
    RAISE EXCEPTION 'T1: refund nuevo no quedó en compensaciones_nuevas (%)', v_r;
  END IF;
  INSERT INTO _w6d_res VALUES (1,'refund nuevo → aparece en compensaciones_nuevas','OK');

  -- T2: REPLAY del mismo refund.id (evento distinto, mismo refund_id) → vacío, SIN spam
  v_r := stripe_procesar_socio('evt_w6d_2','reembolso', jsonb_build_object(
    'account_id','acct_w6d','charge_id','ch_w6d','payment_intent','pi_w6d',
    'refs', jsonb_build_array('ch_w6d','pi_w6d','cs_w6d'),
    'refunds', jsonb_build_array(jsonb_build_object('refund_id','re_w6d_1','amount',20000))));
  IF jsonb_array_length(v_r->'compensaciones_nuevas') <> 0 THEN
    RAISE EXCEPTION 'T2: replay del mismo refund.id reapareció en compensaciones_nuevas (notificaría dos veces)';
  END IF;
  INSERT INTO _w6d_res VALUES (2,'replay del mismo refund.id (evento distinto) → compensaciones_nuevas vacío','OK');

  -- T3: SEGUNDO refund distinto, mismo objeto → SÍ aparece (no es spam, es nuevo)
  v_r := stripe_procesar_socio('evt_w6d_3','reembolso', jsonb_build_object(
    'account_id','acct_w6d','charge_id','ch_w6d','payment_intent','pi_w6d',
    'refs', jsonb_build_array('ch_w6d','pi_w6d','cs_w6d'),
    'refunds', jsonb_build_array(jsonb_build_object('refund_id','re_w6d_2','amount',15000))));
  IF jsonb_array_length(v_r->'compensaciones_nuevas') <> 1 THEN RAISE EXCEPTION 'T3: segundo refund distinto no se detectó'; END IF;
  INSERT INTO _w6d_res VALUES (3,'segundo refund.id distinto (mismo objeto) → sí aparece (no es replay)','OK');

  -- T4: disputa ABIERTA (primera vez) → transición = true
  v_r := stripe_procesar_socio('evt_w6d_4','disputa', jsonb_build_object(
    'account_id','acct_w6d','dispute_id','dp_w6d','charge_id','ch_w6d','payment_intent','pi_w6d',
    'refs', jsonb_build_array('ch_w6d','pi_w6d','cs_w6d'),'estado','abierta','amount',15000,'moneda','mxn'));
  IF NOT (v_r->>'disputa_transicion')::boolean THEN RAISE EXCEPTION 'T4: primera vez abierta debía ser transición'; END IF;
  INSERT INTO _w6d_res VALUES (4,'disputa abierta por primera vez → disputa_transicion=true','OK');

  -- T5: REPLAY del mismo estado 'abierta' (evento distinto) → transición = false
  v_r := stripe_procesar_socio('evt_w6d_5','disputa', jsonb_build_object(
    'account_id','acct_w6d','dispute_id','dp_w6d','charge_id','ch_w6d','payment_intent','pi_w6d',
    'refs', jsonb_build_array('ch_w6d','pi_w6d','cs_w6d'),'estado','abierta','amount',15000,'moneda','mxn'));
  IF (v_r->>'disputa_transicion')::boolean THEN RAISE EXCEPTION 'T5: replay de abierta no debía ser transición (spam)'; END IF;
  INSERT INTO _w6d_res VALUES (5,'replay del mismo estado abierta → disputa_transicion=false (sin spam)','OK');

  -- T6: disputa PERDIDA (transición real) → transición=true + compensa
  v_r := stripe_procesar_socio('evt_w6d_6','disputa', jsonb_build_object(
    'account_id','acct_w6d','dispute_id','dp_w6d','charge_id','ch_w6d','payment_intent','pi_w6d',
    'refs', jsonb_build_array('ch_w6d','pi_w6d','cs_w6d'),'estado','perdida','amount',15000,'moneda','mxn'));
  IF NOT (v_r->>'disputa_transicion')::boolean THEN RAISE EXCEPTION 'T6: abierta→perdida debía ser transición'; END IF;
  IF (SELECT compensado FROM stripe_disputas WHERE tenant_id=v_t AND dispute_id='dp_w6d') <> true THEN RAISE EXCEPTION 'T6: no compensó'; END IF;
  INSERT INTO _w6d_res VALUES (6,'disputa perdida (transición real) → disputa_transicion=true + compensa','OK');

  -- T7: REPLAY de 'perdida' (evento distinto, dispute.closed reentregado) → transición=false
  v_r := stripe_procesar_socio('evt_w6d_7','disputa', jsonb_build_object(
    'account_id','acct_w6d','dispute_id','dp_w6d','charge_id','ch_w6d','payment_intent','pi_w6d',
    'refs', jsonb_build_array('ch_w6d','pi_w6d','cs_w6d'),'estado','perdida','amount',15000,'moneda','mxn'));
  IF (v_r->>'disputa_transicion')::boolean THEN RAISE EXCEPTION 'T7: replay de perdida no debía ser transición (notificaría de nuevo)'; END IF;
  INSERT INTO _w6d_res VALUES (7,'replay de perdida (evento distinto) → disputa_transicion=false (sin doble aviso)','OK');

  -- T8: sin_pago intacto (regresión C1b): cargo sin contraparte interna
  v_r := stripe_procesar_socio('evt_w6d_8','reembolso', jsonb_build_object(
    'account_id','acct_w6d','charge_id','ch_nada','payment_intent','pi_nada',
    'refunds', jsonb_build_array(jsonb_build_object('refund_id','re_nada','amount',1000))));
  IF NOT (v_r->>'sin_pago')::boolean THEN RAISE EXCEPTION 'T8: sin_pago no se preservó'; END IF;
  INSERT INTO _w6d_res VALUES (8,'regresión C1b: sin_pago intacto','OK');

  -- T9: stripe_salud_operador — sin sesión admin → SALUD_NO_ADMIN (fail-closed)
  v_ok := false;
  BEGIN PERFORM stripe_salud_operador(30);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'SALUD_NO_ADMIN%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T9: sin admin debió fallar con SALUD_NO_ADMIN'; END IF;
  INSERT INTO _w6d_res VALUES (9,'stripe_salud_operador sin admin → SALUD_NO_ADMIN','OK');

  -- limpieza: nada que limpiar en stripe_event_inbox (no se escribió ninguna fila).
  PERFORM cerrar_tenant(v_slug);
END $outer$;

-- T10: stripe_salud_operador CON admin → cuenta lo de este tenant, aislado de otros.
DO $$
DECLARE
  v_slug  text := 'zz-w6d-'||substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-w6db-'||substr(md5(random()::text),1,6);
  v_t uuid; v_t2 uuid; v_auth uuid := gen_random_uuid(); v_r jsonb;
BEGIN
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config) VALUES (v_slug,'W6Dadm','gym_libre','activo','acct_w6dadm','{}'::jsonb) RETURNING id INTO v_t;
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config) VALUES (v_slug2,'W6Dadm2','gym_libre','activo','acct_w6dadm2','{}'::jsonb) RETURNING id INTO v_t2;
  INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000',v_auth,'authenticated','authenticated',v_slug||'-admin@x.dev',
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth;

  INSERT INTO stripe_disputas (tenant_id, dispute_id, estado) VALUES (v_t, 'dp_mine', 'abierta');
  INSERT INTO stripe_disputas (tenant_id, dispute_id, estado) VALUES (v_t2, 'dp_other', 'abierta');  -- de OTRO tenant

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
  v_r := stripe_salud_operador(30);
  PERFORM set_config('request.jwt.claims','',true);

  IF (v_r->>'tenant_id')::uuid <> v_t THEN RAISE EXCEPTION 'T10: tenant_id devuelto no es el del admin que llama'; END IF;
  IF (v_r->>'disputas_abiertas')::int <> 1 THEN RAISE EXCEPTION 'T10: esperaba 1 disputa abierta (la propia), dio %', v_r->>'disputas_abiertas'; END IF;

  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug2);
  INSERT INTO _w6d_res VALUES (10,'stripe_salud_operador: tenant-scoped (no ve la disputa de otro tenant)','OK');
END $$;

-- T11 (autoridad): anon sin EXECUTE.
DO $$
BEGIN
  IF has_function_privilege('anon','stripe_salud_operador(integer)','EXECUTE') THEN
    RAISE EXCEPTION 'T11: anon puede ejecutar stripe_salud_operador';
  END IF;
  INSERT INTO _w6d_res VALUES (11,'autoridad: anon sin EXECUTE en stripe_salud_operador','OK');
END $$;

SELECT orden, prueba, resultado FROM _w6d_res ORDER BY orden;

COMMIT;
