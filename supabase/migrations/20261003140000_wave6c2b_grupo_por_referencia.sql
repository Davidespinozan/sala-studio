-- ============================================================================
-- W6-C2b — RECONCILIACIÓN: el grupo es el OBJETO Stripe (no la fila de pago)
-- ----------------------------------------------------------------------------
-- Follow-up aditivo de 20261003120000 (que queda intacta como evidencia).
-- Defecto que corrige: una Checkout Session con plan + inscripción se asienta en
-- DOS pagos con la misma referencia; la RPC devolvía solo el pago ancla, así que
-- la comparación contra el total de la sesión daba un falso AMOUNT_MISMATCH.
-- Ahora la RPC expande el conjunto a los pagos hermanos (misma referencia, mismo
-- tenant y socio) y a los reembolsos de cualquiera de ellos.
--
-- Solo lectura. Misma firma, misma autorización (auth + admin + tenant). No toca
-- datos. Rollback: re-aplicar el CREATE OR REPLACE de 20261003120000.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION reconciliar_verdad_interna(p_sujeto text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller uuid := get_my_user_id();
  v_tenant uuid;
  v_acct text; v_charges boolean;
  v_pago_ids uuid[];
  v_ref_objs text[];
  v_out jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'RECON_NO_AUTH'; END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'RECON_NO_ADMIN'; END IF;
  v_tenant := get_my_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'RECON_NO_TENANT'; END IF;
  IF p_sujeto NOT IN ('pago','membresia','socio') THEN RAISE EXCEPTION 'RECON_SUJETO_INVALIDO'; END IF;
  SELECT stripe_account_id, stripe_charges_enabled INTO v_acct, v_charges FROM tenants WHERE id = v_tenant;

  -- Resolver el conjunto de pagos del sujeto, SIEMPRE acotado al tenant del
  -- admin. Si el id no pertenece al tenant → NOT_FOUND (no se filtra existencia).
  IF p_sujeto = 'pago' THEN
    -- grupo de cargo: el pago positivo ancla + sus reembolsos; si el id es un
    -- reembolso, se ancla en su revierte_pago_id.
    DECLARE v_anchor uuid; v_rev uuid;
    BEGIN
      SELECT id, revierte_pago_id INTO v_anchor, v_rev FROM pagos WHERE id = p_id AND tenant_id = v_tenant;
      IF v_anchor IS NULL THEN RAISE EXCEPTION 'RECON_NOT_FOUND'; END IF;
      v_anchor := COALESCE(v_rev, v_anchor);  -- ancla en el positivo
      SELECT array_agg(id) INTO v_pago_ids FROM pagos
        WHERE tenant_id = v_tenant AND (id = v_anchor OR revierte_pago_id = v_anchor);
    END;
  ELSIF p_sujeto = 'membresia' THEN
    PERFORM 1 FROM membresias WHERE id = p_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'RECON_NOT_FOUND'; END IF;
    SELECT array_agg(id) INTO v_pago_ids FROM pagos WHERE tenant_id = v_tenant AND membresia_id = p_id;
  ELSE -- socio
    PERFORM 1 FROM usuarios WHERE id = p_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'RECON_NOT_FOUND'; END IF;
    SELECT array_agg(id) INTO v_pago_ids FROM pagos WHERE tenant_id = v_tenant AND usuario_id = p_id;
  END IF;

  v_pago_ids := COALESCE(v_pago_ids, ARRAY[]::uuid[]);

  -- W6-C2b: la unidad de reconciliación es el OBJETO Stripe, no la fila. Un mismo
  -- objeto (p. ej. una Checkout Session) se asienta en varios pagos con la MISMA
  -- referencia (plan + inscripción: el índice único es tenant+referencia+concepto).
  -- Se expande el conjunto a esos hermanos (mismo tenant y mismo socio)…
  SELECT array_agg(DISTINCT x.id) INTO v_pago_ids FROM (
    SELECT unnest(v_pago_ids) AS id
    UNION
    SELECT h.id
    FROM pagos p0
    JOIN pagos h ON h.tenant_id = v_tenant AND h.referencia = p0.referencia
                AND h.usuario_id = p0.usuario_id AND h.concepto <> 'reembolso'
    WHERE p0.id = ANY(v_pago_ids) AND p0.tenant_id = v_tenant
      AND p0.concepto <> 'reembolso' AND p0.referencia IS NOT NULL
  ) x;
  v_pago_ids := COALESCE(v_pago_ids, ARRAY[]::uuid[]);
  -- …y a los reembolsos que revierten a cualquiera de ellos.
  SELECT array_agg(DISTINCT x.id) INTO v_pago_ids FROM (
    SELECT unnest(v_pago_ids) AS id
    UNION
    SELECT r.id FROM pagos r WHERE r.tenant_id = v_tenant AND r.revierte_pago_id = ANY(v_pago_ids)
  ) x;
  v_pago_ids := COALESCE(v_pago_ids, ARRAY[]::uuid[]);

  -- referencias de Stripe de esos pagos (para juntar evidencia del inbox).
  SELECT array_agg(DISTINCT referencia) INTO v_ref_objs
    FROM pagos WHERE id = ANY(v_pago_ids) AND referencia IS NOT NULL;
  v_ref_objs := COALESCE(v_ref_objs, ARRAY[]::text[]);

  v_out := jsonb_build_object(
    'authorized', true,
    'tenant_id', v_tenant,
    'stripe_account_id', v_acct,
    'stripe_charges_enabled', v_charges,
    'sujeto', p_sujeto,
    'sujeto_id', p_id,
    'pagos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'usuario_id', p.usuario_id, 'membresia_id', p.membresia_id,
        'concepto', p.concepto, 'monto_centavos', p.monto_centavos, 'moneda', p.moneda,
        'metodo', p.metodo, 'referencia', p.referencia, 'revierte_pago_id', p.revierte_pago_id,
        'created_at', p.created_at) ORDER BY p.created_at)
      FROM pagos p WHERE p.id = ANY(v_pago_ids)), '[]'::jsonb),
    'membresias', COALESCE((
      SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'id', m.id, 'stripe_subscription_id', m.stripe_subscription_id,
        'stripe_customer_id', m.stripe_customer_id, 'status', m.status,
        'periodo_actual_inicio', m.periodo_actual_inicio, 'periodo_actual_fin', m.periodo_actual_fin))
      FROM membresias m WHERE m.tenant_id = v_tenant
        AND m.id IN (SELECT membresia_id FROM pagos WHERE id = ANY(v_pago_ids) AND membresia_id IS NOT NULL)), '[]'::jsonb),
    'socios', COALESCE((
      SELECT jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'stripe_customer_id', u.stripe_customer_id))
      FROM usuarios u WHERE u.tenant_id = v_tenant
        AND u.id IN (SELECT usuario_id FROM pagos WHERE id = ANY(v_pago_ids))), '[]'::jsonb),
    'disputas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'dispute_id', d.dispute_id, 'charge_id', d.charge_id, 'pago_id', d.pago_id,
        'estado', d.estado, 'monto_centavos', d.monto_centavos, 'compensado', d.compensado))
      FROM stripe_disputas d WHERE d.tenant_id = v_tenant AND d.pago_id = ANY(v_pago_ids)), '[]'::jsonb),
    'inbox', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'type', i.type, 'object_id', i.object_id, 'estado', i.estado,
        'stripe_created_at', i.stripe_created_at))
      FROM stripe_event_inbox i
      WHERE i.tenant_id = v_tenant AND i.object_id = ANY(v_ref_objs)), '[]'::jsonb)
  );
  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION reconciliar_verdad_interna(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reconciliar_verdad_interna(text, uuid) TO authenticated, service_role;

-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenants desechables; cerrar_tenant limpia.
-- No escribe stripe_event_inbox (convención C1: nada que limpiar por account_id).
-- ============================================================================
CREATE TEMP TABLE _w6c2b_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug  text := 'zz-w6c2b-'||substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-w6c2c-'||substr(md5(random()::text),1,6);
  v_t uuid; v_t2 uuid; v_u uuid; v_uo uuid; v_u2 uuid; v_tier uuid; v_tier2 uuid; v_mem uuid;
  v_plan uuid; v_insc uuid; v_reemb uuid; v_otro uuid; v_ajeno uuid;
  v_auth uuid := gen_random_uuid();
  v_r jsonb; v_ok boolean;
BEGIN
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
    VALUES (v_slug,'W6C2b','gym_libre','activo','acct_c2x','{}'::jsonb) RETURNING id INTO v_t;
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
    VALUES (v_slug2,'W6C2c','gym_libre','activo','acct_c2y','{}'::jsonb) RETURNING id INTO v_t2;
  INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000',v_auth,'authenticated','authenticated',v_slug||'-admin@x.dev',
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth;

  INSERT INTO usuarios (tenant_id,email,nombre,rol,status,stripe_customer_id) VALUES (v_t,v_slug||'-a@x.dev','A','miembro','activo','cus_c2x') RETURNING id INTO v_u;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t,v_slug||'-b@x.dev','B','miembro','activo') RETURNING id INTO v_uo;
  INSERT INTO tiers (tenant_id,slug,nombre,precio_centavos,tipo,duracion_dias) VALUES (v_t,'c2bt','T',50000,'tiempo',30) RETURNING id INTO v_tier;
  INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,stripe_subscription_id)
    VALUES (v_t,v_u,v_tier,'activa',now()-interval '5 days',now()+interval '25 days','sub_c2x') RETURNING id INTO v_mem;
  -- una sesión: plan + inscripción con la MISMA referencia; la inscripción sin membresia_id
  INSERT INTO pagos (tenant_id,usuario_id,membresia_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
    VALUES (v_t,v_u,v_mem,v_tier,'plan',50000,'MXN','stripe','cs_c2x') RETURNING id INTO v_plan;
  INSERT INTO pagos (tenant_id,usuario_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
    VALUES (v_t,v_u,v_tier,'inscripcion',30000,'MXN','stripe','cs_c2x') RETURNING id INTO v_insc;
  INSERT INTO pagos (tenant_id,usuario_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia,revierte_pago_id)
    VALUES (v_t,v_u,v_tier,'reembolso',-30000,'MXN','stripe','re_c2x',v_insc) RETURNING id INTO v_reemb;
  -- otro socio del mismo gym con otro cobro (no debe colarse)
  INSERT INTO pagos (tenant_id,usuario_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
    VALUES (v_t,v_uo,v_tier,'paquete',20000,'MXN','stripe','cs_c2_otro') RETURNING id INTO v_otro;
  -- otro tenant
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t2,v_slug2||'@x.dev','Z','miembro','activo') RETURNING id INTO v_u2;
  INSERT INTO tiers (tenant_id,slug,nombre,precio_centavos,tipo,duracion_dias) VALUES (v_t2,'c2ct','T',50000,'tiempo',30) RETURNING id INTO v_tier2;
  INSERT INTO pagos (tenant_id,usuario_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
    VALUES (v_t2,v_u2,v_tier2,'paquete',30000,'MXN','stripe','cs_c2x') RETURNING id INTO v_ajeno;  -- MISMA referencia en otro tenant

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- T1: ancla = plan → trae plan + inscripción (misma referencia) + el reembolso de la inscripción
  v_r := reconciliar_verdad_interna('pago', v_plan);
  IF jsonb_array_length(v_r->'pagos') <> 3 THEN RAISE EXCEPTION 'T1: esperaba 3 pagos, hay %', jsonb_array_length(v_r->'pagos'); END IF;
  INSERT INTO _w6c2b_res VALUES (1,'ancla plan → plan + inscripción (misma referencia) + reembolso','OK');

  -- T2: ancla = reembolso de la inscripción → mismo grupo completo
  v_r := reconciliar_verdad_interna('pago', v_reemb);
  IF jsonb_array_length(v_r->'pagos') <> 3 THEN RAISE EXCEPTION 'T2: anclar por reembolso dio %', jsonb_array_length(v_r->'pagos'); END IF;
  INSERT INTO _w6c2b_res VALUES (2,'ancla reembolso → mismo grupo completo','OK');

  -- T3: sujeto membresía → incluye la inscripción aunque no tenga membresia_id
  v_r := reconciliar_verdad_interna('membresia', v_mem);
  IF jsonb_array_length(v_r->'pagos') <> 3 THEN RAISE EXCEPTION 'T3: membresía dio %', jsonb_array_length(v_r->'pagos'); END IF;
  INSERT INTO _w6c2b_res VALUES (3,'sujeto membresía → incluye inscripción hermana + reembolso','OK');

  -- T4: no se cuela el cobro de OTRO socio ni el de OTRO tenant con la misma referencia
  v_r := reconciliar_verdad_interna('socio', v_u);
  IF jsonb_array_length(v_r->'pagos') <> 3 THEN RAISE EXCEPTION 'T4: socio dio %', jsonb_array_length(v_r->'pagos'); END IF;
  IF v_r->'pagos' @> jsonb_build_array(jsonb_build_object('id', v_otro)) OR v_r->'pagos' @> jsonb_build_array(jsonb_build_object('id', v_ajeno)) THEN
    RAISE EXCEPTION 'T4: se coló un pago ajeno';
  END IF;
  INSERT INTO _w6c2b_res VALUES (4,'no se cuela otro socio ni otro tenant (misma referencia)','OK');

  -- T5: aislamiento intacto — pago de otro tenant → RECON_NOT_FOUND
  v_ok := false;
  BEGIN PERFORM reconciliar_verdad_interna('pago', v_ajeno);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'RECON_NOT_FOUND%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T5: leyó un pago de otro tenant'; END IF;
  INSERT INTO _w6c2b_res VALUES (5,'aislamiento intacto: pago de otro tenant → RECON_NOT_FOUND','OK');

  -- T6: cero mutación
  IF (SELECT count(*) FROM pagos WHERE tenant_id IN (v_t, v_t2)) <> 5 THEN RAISE EXCEPTION 'T6: cambió el número de pagos'; END IF;
  INSERT INTO _w6c2b_res VALUES (6,'cero mutación: pagos intactos','OK');

  PERFORM set_config('request.jwt.claims','',true);
  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug2);
END $outer$;

DO $$
BEGIN
  IF has_function_privilege('anon','reconciliar_verdad_interna(text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'T7: anon puede ejecutar la RPC';
  END IF;
  INSERT INTO _w6c2b_res VALUES (7,'autoridad intacta: anon sin EXECUTE','OK');
END $$;

SELECT orden, prueba, resultado FROM _w6c2b_res ORDER BY orden;

COMMIT;
