-- ============================================================================
-- W6-C2 — VERDAD INTERNA PARA RECONCILIACIÓN ON-DEMAND (read-only)
-- ----------------------------------------------------------------------------
-- RPC que arma la verdad económica INTERNA normalizada de un sujeto, para que
-- la Netlify Function `reconciliar-stripe` la compare contra Stripe (read-only).
--
-- Invariantes:
--   · SOLO lectura (no muta nada).
--   · auth + rol admin + tenant ownership (nunca cruza tenants).
--   · acepta SOLO identificadores INTERNOS (uuid); jamás un Stripe ID crudo como
--     sustituto del ownership (un 'pi_'/'cus_'/'sub_' no es uuid → ni entra).
--   · devuelve lo mínimo para reconciliar (sin exponer de más).
--
-- Aditiva. authenticated puede EXECUTE pero la función se cierra a admin del
-- tenant por dentro. No toca W1-W5/A1/A2/B/C1. Rollback: DROP FUNCTION.
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
-- SELF-TESTS (DEVUELVEN TABLA) — tenant desechable; cerrar_tenant limpia.
-- Nota hygiene C1: este self-test NO escribe stripe_event_inbox, así que no hay
-- residuo que limpiar por account_id; aun así cerrar_tenant borra todo el tenant.
-- ============================================================================
CREATE TEMP TABLE _w6c2_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug  text := 'zz-w6c2-'||substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-w6c2b-'||substr(md5(random()::text),1,6);
  v_t uuid; v_t2 uuid; v_u uuid; v_u2 uuid; v_tier uuid; v_tier2 uuid; v_mem uuid;
  v_pago uuid; v_reemb uuid; v_pago_ajeno uuid;
  v_auth uuid := gen_random_uuid();
  v_auth2 uuid := gen_random_uuid();   -- segundo usuario con sesión, NO admin
  v_r jsonb; v_ok boolean;
BEGIN
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
    VALUES (v_slug,'W6C2','gym_libre','activo','acct_c2','{}'::jsonb) RETURNING id INTO v_t;
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
    VALUES (v_slug2,'W6C2b','gym_libre','activo','acct_c2b','{}'::jsonb) RETURNING id INTO v_t2;

  -- Admin con sesión simulada (patrón W6-A1): auth.users → el trigger crea su
  -- ficha en el tenant del slug → se promueve a admin → se setea el JWT.
  INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000',v_auth,'authenticated','authenticated',v_slug||'-admin@x.dev',
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth;
  IF NOT EXISTS (SELECT 1 FROM usuarios WHERE auth_id=v_auth AND tenant_id=v_t AND rol='admin') THEN
    RAISE EXCEPTION 'SETUP: no se creó la ficha admin del tenant de prueba';
  END IF;

  -- datos del tenant propio
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status,stripe_customer_id)
    VALUES (v_t,v_slug||'@x.dev','U','miembro','activo','cus_c2') RETURNING id INTO v_u;
  INSERT INTO tiers (tenant_id,slug,nombre,precio_centavos,tipo,duracion_dias) VALUES (v_t,'c2t','T',50000,'tiempo',30) RETURNING id INTO v_tier;
  INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,stripe_subscription_id)
    VALUES (v_t,v_u,v_tier,'activa',now()-interval '5 days',now()+interval '25 days','sub_c2') RETURNING id INTO v_mem;
  INSERT INTO pagos (tenant_id,usuario_id,membresia_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
    VALUES (v_t,v_u,v_mem,v_tier,'plan',50000,'MXN','stripe','pi_c2a') RETURNING id INTO v_pago;
  INSERT INTO pagos (tenant_id,usuario_id,membresia_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia,revierte_pago_id)
    VALUES (v_t,v_u,v_mem,v_tier,'reembolso',-20000,'MXN','stripe','re_c2a',v_pago) RETURNING id INTO v_reemb;

  -- un pago en OTRO tenant (para aislamiento)
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t2,v_slug2||'@x.dev','U2','miembro','activo') RETURNING id INTO v_u2;
  INSERT INTO tiers (tenant_id,slug,nombre,precio_centavos,tipo,duracion_dias) VALUES (v_t2,'c2tb','T',50000,'tiempo',30) RETURNING id INTO v_tier2;
  INSERT INTO pagos (tenant_id,usuario_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
    VALUES (v_t2,v_u2,v_tier2,'paquete',30000,'MXN','stripe','pi_c2_ajeno') RETURNING id INTO v_pago_ajeno;

  -- T0: SIN sesión → RECON_NO_AUTH
  v_ok := false;
  BEGIN PERFORM reconciliar_verdad_interna('pago', v_pago);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'RECON_NO_AUTH%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T0: sin sesión no dio RECON_NO_AUTH'; END IF;
  INSERT INTO _w6c2_res VALUES (0,'sin sesión → RECON_NO_AUTH','OK');

  -- sesión del admin del tenant propio
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- T1: sujeto pago → grupo de cargo (positivo + reembolso), tenant+account resueltos
  v_r := reconciliar_verdad_interna('pago', v_pago);
  IF (v_r->>'stripe_account_id') <> 'acct_c2' THEN RAISE EXCEPTION 'T1: account'; END IF;
  IF jsonb_array_length(v_r->'pagos') <> 2 THEN RAISE EXCEPTION 'T1: grupo != 2 pagos'; END IF;
  INSERT INTO _w6c2_res VALUES (1,'sujeto pago → grupo de cargo (positivo + reembolso) + account','OK');

  -- T2: anclar por el REEMBOLSO devuelve el mismo grupo
  v_r := reconciliar_verdad_interna('pago', v_reemb);
  IF jsonb_array_length(v_r->'pagos') <> 2 THEN RAISE EXCEPTION 'T2: anclar por reembolso no agrupó'; END IF;
  INSERT INTO _w6c2_res VALUES (2,'anclar por reembolso → mismo grupo (positivo)','OK');

  -- T3: sujeto socio → todos sus pagos; customer resuelto
  v_r := reconciliar_verdad_interna('socio', v_u);
  IF jsonb_array_length(v_r->'pagos') <> 2 THEN RAISE EXCEPTION 'T3: socio pagos'; END IF;
  IF (v_r->'socios'->0->>'stripe_customer_id') <> 'cus_c2' THEN RAISE EXCEPTION 'T3: customer'; END IF;
  INSERT INTO _w6c2_res VALUES (3,'sujeto socio → sus pagos + stripe_customer_id','OK');

  -- T4: sujeto membresía → pagos de esa membresía + sub id
  v_r := reconciliar_verdad_interna('membresia', v_mem);
  IF (v_r->'membresias'->0->>'stripe_subscription_id') <> 'sub_c2' THEN RAISE EXCEPTION 'T4: sub'; END IF;
  INSERT INTO _w6c2_res VALUES (4,'sujeto membresía → pagos + stripe_subscription_id','OK');

  -- T5: AISLAMIENTO — admin del tenant A pide un pago/socio REAL del tenant B → NOT_FOUND
  v_ok := false;
  BEGIN PERFORM reconciliar_verdad_interna('pago', v_pago_ajeno);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'RECON_NOT_FOUND%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T5: leyó un pago de otro tenant'; END IF;
  v_ok := false;
  BEGIN PERFORM reconciliar_verdad_interna('socio', v_u2);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'RECON_NOT_FOUND%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T5: leyó un socio de otro tenant'; END IF;
  INSERT INTO _w6c2_res VALUES (5,'aislamiento: pago/socio de OTRO tenant → RECON_NOT_FOUND','OK');

  -- T6: ROL no autorizado — otro usuario con sesión válida pero NO admin (no se
  --     degrada a nadie: iam_proteccion_critica protege al último admin).
  INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000',v_auth2,'authenticated','authenticated',v_slug||'-socio@x.dev',
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('tenant_slug',v_slug,'nombre','Socio'),now(),now());
  IF EXISTS (SELECT 1 FROM usuarios WHERE auth_id=v_auth2 AND rol='admin') THEN
    RAISE EXCEPTION 'SETUP: el segundo usuario no debía ser admin';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth2::text)::text, true);
  v_ok := false;
  BEGIN PERFORM reconciliar_verdad_interna('pago', v_pago);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'RECON_NO_ADMIN%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T6: un no-admin pudo reconciliar'; END IF;
  INSERT INTO _w6c2_res VALUES (6,'rol no autorizado (sesión no-admin) → RECON_NO_ADMIN','OK');

  -- T7: CERO mutación — la RPC es STABLE/solo lectura: los pagos no cambiaron
  IF (SELECT count(*) FROM pagos WHERE tenant_id IN (v_t, v_t2)) <> 3 THEN RAISE EXCEPTION 'T7: cambió el número de pagos'; END IF;
  INSERT INTO _w6c2_res VALUES (7,'cero mutación: pagos intactos tras reconciliar','OK');

  PERFORM set_config('request.jwt.claims','',true);

  -- limpieza. Este self-test NO escribe stripe_event_inbox (convención C1: si lo
  -- hiciera, habría que DELETE por account_id antes de cerrar_tenant).
  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug2);
END $outer$;

-- T8 (autoridad): anon NO puede ejecutar; authenticated sí (la función gatea admin adentro).
DO $$
BEGIN
  IF has_function_privilege('anon','reconciliar_verdad_interna(text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'T8: anon puede ejecutar la RPC';
  END IF;
  IF NOT has_function_privilege('authenticated','reconciliar_verdad_interna(text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'T8: authenticated no puede ejecutar (se gatea admin adentro)';
  END IF;
  INSERT INTO _w6c2_res VALUES (8,'autoridad: anon sin EXECUTE; admin-gate interno','OK');
END $$;

SELECT orden, prueba, resultado FROM _w6c2_res ORDER BY orden;

COMMIT;
