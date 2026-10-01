-- ============================================================================
-- WAVE 6 · A2 (DB) — Dispatchers atómicos de procesamiento + reaper
-- ----------------------------------------------------------------------------
-- Los webhooks (A2, edge) hacen: verify → receive → claim → DISPATCHER → 200,
-- o failed/500. El DISPATCHER hace {efecto de negocio + _stripe_inbox_processed}
-- en UNA transacción (el cuerpo de la función = una tx): si el efecto revierte,
-- processed NO queda; si processed queda, el efecto commiteó. Cierra el contrato
-- de completion atómico del diseño congelado.
--
-- Reusa efectos existentes (activar_suscripcion_socio, stripe_aplicar_estado_
-- membresia [A1], registrar_venta_online) y helpers del inbox [A1]. Porta el
-- efecto SaaS (applyIfNewer + movimientos_dinero + sync módulo tienda) a SQL para
-- que sea atómico con processed. NO amplía el catálogo de eventos (eso es C1).
-- service_role-only. No toca créditos/entitlement. Aditivo; BEGIN/COMMIT + tests.
--
-- ROLLBACK A2-DB: DROP de stripe_procesar_socio, stripe_procesar_saas,
--   _stripe_saas_sync_modulo_tienda, _stripe_inbox_reap. (No toca A1 ni W1-W5.)
-- ============================================================================

BEGIN;

-- ── Reaper de 'processing' colgado (crash entre claim y dispatcher) ─────────
-- Devuelve a 'failed' (re-claimable) los eventos atascados en processing más
-- viejos que el intervalo. Se programará en W6-F; acá queda disponible para ops.
CREATE OR REPLACE FUNCTION _stripe_inbox_reap(p_older_than interval DEFAULT interval '15 minutes')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE stripe_event_inbox
  SET estado = 'failed', ultimo_error = COALESCE(ultimo_error,'reaped: stale processing'), updated_at = now()
  WHERE estado = 'processing' AND processing_at < now() - p_older_than;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;

-- ── Sync del módulo tienda (SaaS) — con veto de módulo comp ──────────────────
CREATE OR REPLACE FUNCTION _stripe_saas_sync_modulo_tienda(p_tenant uuid, p_activo boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_config jsonb; v_comp boolean; v_target boolean; v_cur boolean;
BEGIN
  SELECT config INTO v_config FROM tenants WHERE id = p_tenant;
  v_comp   := COALESCE((v_config->'modulos_comp'->>'tienda')::boolean, false);
  v_target := COALESCE(p_activo,false) OR v_comp;   -- comp solo PRENDE; nunca apaga
  v_cur    := COALESCE((v_config->'modulos'->>'tienda')::boolean, false);
  IF v_cur IS DISTINCT FROM v_target THEN
    UPDATE tenants
    SET config = jsonb_set(COALESCE(config,'{}'::jsonb), '{modulos}',
          COALESCE(config->'modulos','{}'::jsonb) || jsonb_build_object('tienda', to_jsonb(v_target)))
    WHERE id = p_tenant;
  END IF;
END; $$;

-- ── DISPATCHER SOCIO (Connect) ──────────────────────────────────────────────
-- Asume el evento ya reclamado (estado='processing'). Hace efecto + processed en
-- una tx. Kinds: activar | estado | venta_online | account.
CREATE OR REPLACE FUNCTION stripe_procesar_socio(p_event_id text, p_kind text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res jsonb;
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
    -- Sin membresía ligada (posible evento temprano/carrera): NO marcar processed;
    -- que Stripe reintente (o el reaper) hasta que exista o caiga a dead.
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

  ELSE
    RAISE EXCEPTION 'STRIPE_KIND_INVALIDO: %', p_kind;
  END IF;

  PERFORM _stripe_inbox_processed(p_event_id);
  RETURN jsonb_build_object('ok', true, 'kind', p_kind);
END; $$;

-- ── DISPATCHER SAAS ─────────────────────────────────────────────────────────
-- Kinds: sub | invoice. applyIfNewer + módulo + movimientos, todo con processed
-- en una tx. Preserva la semántica SaaS actual (cortesía, orden, idempotencia).
CREATE OR REPLACE FUNCTION stripe_procesar_saas(p_event_id text, p_kind text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_last timestamptz; v_event_at timestamptz; v_cortesia boolean;
  v_centavos integer; v_err_code text;
BEGIN
  v_event_at := (p_args->>'event_at')::timestamptz;

  IF p_kind = 'sub' THEN
    v_tenant := (p_args->>'tenant_id')::uuid;
    -- Cortesía: SALA regala el servicio; ningún evento Stripe toca su fila.
    SELECT COALESCE((config->'saas'->>'cortesia')::boolean,false) INTO v_cortesia FROM tenants WHERE id = v_tenant;
    IF v_cortesia THEN
      PERFORM _stripe_inbox_processed(p_event_id);
      RETURN jsonb_build_object('ok', true, 'skip', 'cortesia');
    END IF;

    SELECT last_event_at INTO v_last FROM suscripciones_saas WHERE tenant_id = v_tenant;
    IF v_last IS NULL OR v_event_at >= v_last THEN
      INSERT INTO suscripciones_saas (
        tenant_id, tier, moneda, ciclo, estado, stripe_customer_id, stripe_subscription_id,
        stripe_price_id, trial_termina, periodo_actual_termina, cancel_at_period_end,
        payment_past_due, precio_centavos, last_event_at
      ) VALUES (
        v_tenant, p_args->>'tier', p_args->>'moneda', p_args->>'ciclo', p_args->>'estado',
        NULLIF(p_args->>'stripe_customer_id',''), NULLIF(p_args->>'stripe_subscription_id',''),
        NULLIF(p_args->>'stripe_price_id',''), NULLIF(p_args->>'trial_termina','')::timestamptz,
        NULLIF(p_args->>'periodo_actual_termina','')::timestamptz,
        COALESCE((p_args->>'cancel_at_period_end')::boolean,false),
        COALESCE((p_args->>'payment_past_due')::boolean,false),
        NULLIF(p_args->>'precio_centavos','')::integer, v_event_at
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        tier = EXCLUDED.tier, moneda = EXCLUDED.moneda, ciclo = EXCLUDED.ciclo,
        estado = EXCLUDED.estado, stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id, stripe_price_id = EXCLUDED.stripe_price_id,
        trial_termina = EXCLUDED.trial_termina, periodo_actual_termina = EXCLUDED.periodo_actual_termina,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end, payment_past_due = EXCLUDED.payment_past_due,
        precio_centavos = COALESCE(EXCLUDED.precio_centavos, suscripciones_saas.precio_centavos),
        last_event_at = EXCLUDED.last_event_at;
    END IF;

    PERFORM _stripe_saas_sync_modulo_tienda(v_tenant, COALESCE((p_args->>'tienda_viva')::boolean,false));
    PERFORM _stripe_inbox_processed(p_event_id);
    RETURN jsonb_build_object('ok', true);

  ELSIF p_kind = 'invoice' THEN
    SELECT tenant_id, last_event_at INTO v_tenant, v_last
    FROM suscripciones_saas WHERE stripe_customer_id = p_args->>'stripe_customer_id';
    IF v_tenant IS NULL THEN
      PERFORM _stripe_inbox_processed(p_event_id);  -- no es de SALA: handled
      RETURN jsonb_build_object('ok', true, 'skip', 'no_tenant');
    END IF;
    IF v_last IS NOT NULL AND v_event_at < v_last THEN
      PERFORM _stripe_inbox_processed(p_event_id);  -- fuera de orden: handled
      RETURN jsonb_build_object('ok', true, 'skip', 'stale');
    END IF;

    UPDATE suscripciones_saas
    SET payment_past_due = COALESCE((p_args->>'past_due')::boolean,false), last_event_at = v_event_at
    WHERE tenant_id = v_tenant;

    v_centavos := COALESCE(NULLIF(p_args->>'amount_paid','')::integer, 0);
    IF COALESCE((p_args->>'past_due')::boolean,false) = false AND v_centavos > 0 THEN
      BEGIN
        INSERT INTO movimientos_dinero (negocio, ocurrido_en, monto_centavos, moneda, concepto, metodo, referencia_externa, tenant_id, metadata)
        VALUES ('sala', COALESCE(NULLIF(p_args->>'pagado_en','')::timestamptz, v_event_at), v_centavos,
                upper(COALESCE(p_args->>'moneda','MXN')), 'suscripcion', 'stripe',
                p_args->>'referencia_externa', v_tenant, COALESCE(p_args->'metadata','{}'::jsonb));
      EXCEPTION WHEN unique_violation THEN NULL;  -- 23505 = ya registrado (reintento): ok
      END;
    END IF;

    PERFORM _stripe_inbox_processed(p_event_id);
    RETURN jsonb_build_object('ok', true);

  ELSE
    RAISE EXCEPTION 'STRIPE_KIND_INVALIDO: %', p_kind;
  END IF;
END; $$;

-- ── GRANTS: service_role-only ────────────────────────────────────────────────
DO $$
DECLARE fn text;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    '_stripe_inbox_reap(interval)',
    '_stripe_saas_sync_modulo_tienda(uuid,boolean)',
    'stripe_procesar_socio(text,text,jsonb)',
    'stripe_procesar_saas(text,text,jsonb)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenant desechable; cerrar_tenant limpia.
-- ============================================================================
CREATE TEMP TABLE _w6a2_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug text := 'zz-w6a2-'||substr(md5(random()::text),1,6);
  v_tenant uuid; v_u uuid; v_tier uuid; v_mem uuid;
  v_sub text := 'sub_'||substr(md5(random()::text),1,8);
  v_ev text; v_row stripe_event_inbox; v_r jsonb; v_status text; v_vig boolean; v_ptr uuid; v_ok boolean;
BEGIN
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
  VALUES (v_slug,'W6A2','gym_libre','activo','acct_w6a2','{"saas":{}}'::jsonb) RETURNING id INTO v_tenant;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'@x.dev','U','miembro','activo') RETURNING id INTO v_u;
  INSERT INTO tiers (tenant_id,slug,nombre,precio_centavos,tipo,duracion_dias) VALUES (v_tenant,'w6a2-t','T',100000,'tiempo',30) RETURNING id INTO v_tier;
  INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,stripe_subscription_id)
  VALUES (v_tenant,v_u,v_tier,'activa',now(),now()+interval '30 days',v_sub) RETURNING id INTO v_mem;

  -- T1: dispatcher socio 'estado' past_due → efecto + processed atómico
  v_ev := 'evt_'||substr(md5(random()::text),1,8);
  PERFORM _stripe_inbox_receive(v_ev,'socio','invoice.payment_failed','acct_w6a2',v_tenant,v_sub,now(),'{}');
  v_row := _stripe_inbox_claim(v_ev);
  v_r := stripe_procesar_socio(v_ev,'estado', jsonb_build_object('stripe_subscription_id',v_sub,'nuevo_status','past_due','event_created',now()::text,'account_id','acct_w6a2'));
  IF (v_r->>'ok')::boolean <> true THEN RAISE EXCEPTION 'T1: dispatcher no ok'; END IF;
  IF (SELECT status FROM membresias WHERE id=v_mem) <> 'past_due' THEN RAISE EXCEPTION 'T1: no aplicó past_due'; END IF;
  IF (SELECT estado FROM stripe_event_inbox WHERE id=v_ev) <> 'processed' THEN RAISE EXCEPTION 'T1: no quedó processed'; END IF;
  SELECT vigente INTO v_vig FROM v_socio_membresia WHERE usuario_id=v_u;
  IF v_vig IS DISTINCT FROM false THEN RAISE EXCEPTION 'T1: past_due quedó vigente'; END IF;
  INSERT INTO _w6a2_res VALUES (1,'dispatcher socio estado→past_due: efecto+processed atómico, no-vigente','OK');

  -- T2: atomicidad — efecto que revienta NO deja processed ni efecto
  DECLARE v_ev2 text := 'evt_'||substr(md5(random()::text),1,8);
  BEGIN
    PERFORM _stripe_inbox_receive(v_ev2,'socio','customer.subscription.deleted','acct_w6a2',v_tenant,v_sub,now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev2);
    BEGIN
      -- kind inválido → RAISE dentro del dispatcher → rollback de su tx
      PERFORM stripe_procesar_socio(v_ev2,'kind_que_no_existe','{}'::jsonb);
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF (SELECT estado FROM stripe_event_inbox WHERE id=v_ev2) <> 'processing' THEN RAISE EXCEPTION 'T2: quedó processed pese al error'; END IF;
  END;
  INSERT INTO _w6a2_res VALUES (2,'atomicidad: dispatcher que revienta no deja processed','OK');

  -- T3: 'estado' sin membresía → RAISE STRIPE_NO_MEMBERSHIP (retryable, no processed)
  DECLARE v_ev3 text := 'evt_'||substr(md5(random()::text),1,8); v_sub_x text := 'sub_inexistente_x';
  BEGIN
    PERFORM _stripe_inbox_receive(v_ev3,'socio','customer.subscription.deleted','acct_w6a2',v_tenant,v_sub_x,now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev3);
    v_ok := false;
    BEGIN PERFORM stripe_procesar_socio(v_ev3,'estado', jsonb_build_object('stripe_subscription_id',v_sub_x,'nuevo_status','cancelada','event_created',now()::text,'account_id','acct_w6a2'));
    EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'STRIPE_NO_MEMBERSHIP%'; END;
    IF NOT v_ok THEN RAISE EXCEPTION 'T3: sub sin membresía no dio STRIPE_NO_MEMBERSHIP'; END IF;
  END;
  INSERT INTO _w6a2_res VALUES (3,'estado sin membresía → STRIPE_NO_MEMBERSHIP (retryable)','OK');

  -- T4: reaper devuelve processing colgado a failed
  DECLARE v_ev4 text := 'evt_'||substr(md5(random()::text),1,8);
  BEGIN
    PERFORM _stripe_inbox_receive(v_ev4,'socio','x','acct_w6a2',v_tenant,v_sub,now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev4);
    UPDATE stripe_event_inbox SET processing_at = now() - interval '1 hour' WHERE id=v_ev4;
    IF _stripe_inbox_reap(interval '15 minutes') < 1 THEN RAISE EXCEPTION 'T4: reaper no recuperó'; END IF;
    IF (SELECT estado FROM stripe_event_inbox WHERE id=v_ev4) <> 'failed' THEN RAISE EXCEPTION 'T4: no quedó failed'; END IF;
  END;
  INSERT INTO _w6a2_res VALUES (4,'reaper: processing colgado → failed (re-claimable)','OK');

  -- T5: dispatcher SaaS 'sub' — upsert + módulo tienda; luego evento viejo no pisa
  DECLARE v_ev5 text := 'evt_'||substr(md5(random()::text),1,8); v_cust text := 'cus_'||substr(md5(random()::text),1,8);
  BEGIN
    PERFORM _stripe_inbox_receive(v_ev5,'saas','customer.subscription.updated',NULL,v_tenant,'subx',now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev5);
    v_r := stripe_procesar_saas(v_ev5,'sub', jsonb_build_object('tenant_id',v_tenant,'tier','starter','moneda','mxn','ciclo','mensual','estado','activa','stripe_customer_id',v_cust,'stripe_subscription_id','subx','precio_centavos',120000,'event_at',now()::text,'tienda_viva',true));
    IF (v_r->>'ok')::boolean <> true THEN RAISE EXCEPTION 'T5: saas sub no ok'; END IF;
    IF (SELECT estado FROM suscripciones_saas WHERE tenant_id=v_tenant) <> 'activa' THEN RAISE EXCEPTION 'T5: suscripciones_saas no quedó activa'; END IF;
    IF COALESCE((SELECT (config->'modulos'->>'tienda')::boolean FROM tenants WHERE id=v_tenant),false) <> true THEN RAISE EXCEPTION 'T5: módulo tienda no se prendió'; END IF;
  END;
  INSERT INTO _w6a2_res VALUES (5,'dispatcher SaaS sub: upsert suscripciones_saas + módulo tienda','OK');

  -- T6: SaaS invoice paid → movimientos_dinero idempotente (2ª vez no duplica)
  DECLARE v_ev6 text := 'evt_'||substr(md5(random()::text),1,8); v_ev6b text := 'evt_'||substr(md5(random()::text),1,8); v_inv text := 'in_'||substr(md5(random()::text),1,8); v_cust6 text;
  BEGIN
    SELECT stripe_customer_id INTO v_cust6 FROM suscripciones_saas WHERE tenant_id=v_tenant;
    PERFORM _stripe_inbox_receive(v_ev6,'saas','invoice.paid',NULL,v_tenant,v_inv,now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev6);
    PERFORM stripe_procesar_saas(v_ev6,'invoice', jsonb_build_object('stripe_customer_id',v_cust6,'event_at',now()::text,'past_due',false,'amount_paid',100000,'moneda','MXN','referencia_externa',v_inv));
    IF (SELECT count(*) FROM movimientos_dinero WHERE referencia_externa=v_inv) <> 1 THEN RAISE EXCEPTION 'T6: no asentó 1 movimiento'; END IF;
    -- segundo evento, misma factura → 23505 ignorado, no duplica
    PERFORM _stripe_inbox_receive(v_ev6b,'saas','invoice.paid',NULL,v_tenant,v_inv,now()+interval '1 min','{}');
    PERFORM _stripe_inbox_claim(v_ev6b);
    PERFORM stripe_procesar_saas(v_ev6b,'invoice', jsonb_build_object('stripe_customer_id',v_cust6,'event_at',(now()+interval '1 min')::text,'past_due',false,'amount_paid',100000,'moneda','MXN','referencia_externa',v_inv));
    IF (SELECT count(*) FROM movimientos_dinero WHERE referencia_externa=v_inv) <> 1 THEN RAISE EXCEPTION 'T6: movimiento duplicado'; END IF;
  END;
  INSERT INTO _w6a2_res VALUES (6,'dispatcher SaaS invoice: movimientos_dinero idempotente (no duplica)','OK');

  -- limpieza. movimientos_dinero es append-only y su FK NO es CASCADE (cerrar_tenant
  -- no lo borra), así que se limpia explícito bajo la bandera de cierre, ANTES de
  -- cerrar el tenant (mientras tenant_id aún apunta a v_tenant).
  PERFORM set_config('sala.cierre_tenant','on',true);
  DELETE FROM movimientos_dinero WHERE tenant_id = v_tenant;
  PERFORM set_config('sala.cierre_tenant','off',true);
  DELETE FROM stripe_event_inbox WHERE account_id = 'acct_w6a2' OR tenant_id = v_tenant;
  PERFORM cerrar_tenant(v_slug);
END $outer$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='stripe_aplicar_estado_membresia') THEN RAISE EXCEPTION 'CONTRATO: A1 writer ausente'; END IF;
  IF to_regclass('public.stripe_webhook_events') IS NULL THEN RAISE EXCEPTION 'CONTRATO: legacy removido'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='trg_membresia_credito_guard') THEN RAISE EXCEPTION 'CONTRATO: W4-A5'; END IF;
  INSERT INTO _w6a2_res VALUES (7,'contract: A1 writer + W4/W5 + legacy coexisten','OK');
END $$;

SELECT orden, prueba, resultado FROM _w6a2_res ORDER BY orden;

COMMIT;
