-- ============================================================================
-- W6-C1 — CICLO ECONÓMICO: REFUNDS / DISPUTES / subscription.updated
-- ----------------------------------------------------------------------------
-- Cierra el ciclo económico de Stripe en Connect, APPEND-ONLY e idempotente:
--
--  · REFUNDS (charge.refunded): cada refund individual por refund.id. Compensa
--    con un asiento NEGATIVO en `pagos` (concepto 'reembolso', revierte_pago_id),
--    soporta parciales y múltiples refunds del mismo charge, y NUNCA compensa de
--    más (se acota a pago_reembolsable → refund + dispute del mismo pago no
--    duplican). Idempotencia económica por refund.id (índice pagos_referencia_unica).
--
--  · DISPUTES: stripe_disputas(open/perdida/ganada). open = persistir + marcar
--    (push lo hace el webhook, best-effort); won = cerrar, sin compensar; lost =
--    compensación append-only idempotente por dispute.id + retiro de vigencia
--    SOLO si pago_financia_periodo_vigente().
--
--  · customer.subscription.updated: sincroniza el ESTADO contractual vía el
--    writer canónico A1 (stripe_aplicar_estado_membresia). NUNCA crea verdad de
--    cobro: el dinero real de un upgrade/proration entra por invoice/payment.
--
-- Ownership: event.account → tenant (A1 _stripe_resolve_tenant); el pago se
-- resuelve por referencia DENTRO del tenant; cross-tenant → RAISE. Idempotencia:
-- inbox (A1/A2) + unique por referencia. La persistencia económica es ATÓMICA;
-- solo el push es best-effort (y vive en el webhook, fuera de esta tx).
--
-- Aditiva. service_role-only. Preserva W4 (append-only, nunca UPDATE/DELETE de
-- pagos), W5 (writer canónico + guards), A1/A2/B y huella. Las migraciones las
-- corre David (SQL Editor). Rollback: DROP de las funciones nuevas + DROP TABLE
-- stripe_disputas + restaurar stripe_procesar_socio a la versión A2.
-- ============================================================================
BEGIN;

-- ── 1) stripe_disputas ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_disputas (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dispute_id      text NOT NULL,                          -- 'dp_...' (único global en Stripe)
  charge_id       text,
  pago_id         uuid REFERENCES pagos(id) ON DELETE SET NULL,
  estado          text NOT NULL CHECK (estado IN ('abierta','perdida','ganada')),
  monto_centavos  integer,
  moneda          text,
  compensado      boolean NOT NULL DEFAULT false,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dispute_id)
);
CREATE INDEX IF NOT EXISTS ix_stripe_disputas_pago ON stripe_disputas (pago_id) WHERE pago_id IS NOT NULL;

ALTER TABLE stripe_disputas ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_disputas FORCE ROW LEVEL SECURITY;
REVOKE ALL ON stripe_disputas FROM PUBLIC, anon, authenticated;
GRANT ALL ON stripe_disputas TO service_role;

-- ── 2) ¿el pago financió el periodo vigente? ────────────────────────────────
-- Verdadero solo si el pago es el cobro de financiamiento (plan/paquete) MÁS
-- reciente de una membresía que AÚN está vigente. Así un refund de "el cobro que
-- paga el mes en curso" retira vigencia, pero un refund de un cobro viejo no.
CREATE OR REPLACE FUNCTION pago_financia_periodo_vigente(p_pago_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pagos p
    JOIN membresias m ON m.id = p.membresia_id
    WHERE p.id = p_pago_id
      AND p.concepto IN ('plan','paquete')
      AND m.status IN ('activa','past_due','trialing')
      AND m.periodo_actual_fin > now()
      AND m.periodo_actual_inicio <= now()
      AND p.id = (
        SELECT p2.id FROM pagos p2
        WHERE p2.membresia_id = m.id AND p2.concepto IN ('plan','paquete')
        ORDER BY p2.created_at DESC LIMIT 1
      )
  );
$$;

-- ── 3) compensación económica (núcleo, service_role-safe, ATÓMICA) ──────────
-- Asienta un reembolso NEGATIVO contra el pago original, idempotente por
-- p_referencia (refund.id / 'dp_'||dispute). Se acota a lo que queda por
-- devolver (pago_reembolsable) → nunca compensa de más. Retira vigencia solo si
-- el pago financió el periodo vigente. NO llama _audrec_log/_op_begin (que desde
-- service_role romperían la tx): el asiento negativo ES la evidencia durable.
CREATE OR REPLACE FUNCTION _stripe_compensar(
  p_tenant uuid, p_pago_id uuid, p_monto integer, p_referencia text, p_motivo text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_pago pagos; v_disp integer; v_monto integer; v_id uuid; v_retiro boolean := false;
BEGIN
  IF p_referencia IS NULL OR p_referencia = '' THEN RAISE EXCEPTION 'COMP_SIN_REFERENCIA'; END IF;
  SELECT * INTO v_pago FROM pagos WHERE id = p_pago_id AND tenant_id = p_tenant FOR UPDATE;
  IF v_pago.id IS NULL THEN RAISE EXCEPTION 'COMP_PAGO_INEXISTENTE'; END IF;

  -- idempotente: ¿ya existe esta compensación (por refund.id/dispute.id)?
  SELECT id INTO v_id FROM pagos
    WHERE tenant_id = p_tenant AND referencia = p_referencia AND concepto = 'reembolso';
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('compensado', true, 'idempotente', true, 'reembolso_id', v_id);
  END IF;

  v_disp := pago_reembolsable(p_pago_id);               -- lo que todavía se puede devolver
  v_monto := LEAST(COALESCE(p_monto, v_disp), v_disp);  -- acota: refund + dispute no duplican
  IF v_monto <= 0 THEN
    RETURN jsonb_build_object('compensado', false, 'reason', 'nada_que_compensar', 'disponible', v_disp);
  END IF;

  BEGIN
    INSERT INTO pagos (
      tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
      concepto, monto_centavos, moneda, metodo, referencia, notas, cobrado_por, revierte_pago_id
    ) VALUES (
      p_tenant, v_pago.sucursal_id, v_pago.usuario_id, v_pago.membresia_id, v_pago.tier_id,
      'reembolso', -v_monto, v_pago.moneda, 'stripe', p_referencia, p_motivo, NULL, p_pago_id
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- carrera: otra entrega del mismo refund/dispute ya asentó la compensación
    -- (pagos_referencia_unica). Es idempotente: devolvemos la existente, sin
    -- retirar vigencia otra vez (ya lo hizo la primera).
    SELECT id INTO v_id FROM pagos
      WHERE tenant_id = p_tenant AND referencia = p_referencia AND concepto = 'reembolso';
    RETURN jsonb_build_object('compensado', true, 'idempotente', true, 'reembolso_id', v_id);
  END;

  IF pago_financia_periodo_vigente(p_pago_id) THEN
    UPDATE membresias SET periodo_actual_fin = now()
      WHERE id = v_pago.membresia_id AND periodo_actual_fin > now();  -- retira vigencia (dispara W5-B)
    v_retiro := true;
  END IF;

  RETURN jsonb_build_object('compensado', true, 'reembolso_id', v_id, 'monto_centavos', v_monto, 'retiro_vigencia', v_retiro);
END; $$;

-- ── 4) resolver pago por charge/PI con ownership (fail-closed cross-tenant) ──
CREATE OR REPLACE FUNCTION _stripe_resolver_pago(p_account_id text, p_charge text, p_pi text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_pid uuid; v_ptenant uuid;
BEGIN
  v_tenant := _stripe_resolve_tenant(p_account_id);
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'STRIPE_OWNERSHIP: cuenta % sin tenant resoluble', p_account_id; END IF;
  SELECT id, tenant_id INTO v_pid, v_ptenant FROM pagos
    WHERE referencia IN (NULLIF(p_charge,''), NULLIF(p_pi,'')) AND concepto <> 'reembolso'
    ORDER BY created_at DESC LIMIT 1;
  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('tenant', v_tenant, 'pago', NULL);   -- no es nuestro / nada que compensar
  END IF;
  IF v_ptenant <> v_tenant THEN
    RAISE EXCEPTION 'STRIPE_OWNERSHIP: pago % pertenece a otro tenant', v_pid;
  END IF;
  RETURN jsonb_build_object('tenant', v_tenant, 'pago', v_pid);
END; $$;

-- ── 5) dispatcher socio: A2 (activar/estado/venta_online/account) + C1 ──────
CREATE OR REPLACE FUNCTION stripe_procesar_socio(p_event_id text, p_kind text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res jsonb; v_rp jsonb; v_tenant uuid; v_pago uuid; v_ref jsonb;
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

  -- ── C1: REEMBOLSO ── cada refund por su refund.id (parciales/múltiples). ──
  ELSIF p_kind = 'reembolso' THEN
    v_rp := _stripe_resolver_pago(p_args->>'account_id', p_args->>'charge_id', p_args->>'payment_intent');
    v_tenant := (v_rp->>'tenant')::uuid; v_pago := NULLIF(v_rp->>'pago','')::uuid;
    IF v_pago IS NOT NULL THEN
      FOR v_ref IN SELECT jsonb_array_elements(COALESCE(p_args->'refunds','[]'::jsonb)) LOOP
        PERFORM _stripe_compensar(v_tenant, v_pago,
          NULLIF(v_ref->>'amount','')::integer, v_ref->>'refund_id',
          'Reembolso Stripe '||(v_ref->>'refund_id'));
      END LOOP;
    END IF;

  -- ── C1: DISPUTA ── open=persistir; won=cerrar; lost=compensar+retirar. ──
  ELSIF p_kind = 'disputa' THEN
    v_rp := _stripe_resolver_pago(p_args->>'account_id', p_args->>'charge_id', p_args->>'payment_intent');
    v_tenant := (v_rp->>'tenant')::uuid; v_pago := NULLIF(v_rp->>'pago','')::uuid;
    INSERT INTO stripe_disputas (tenant_id, dispute_id, charge_id, pago_id, estado, monto_centavos, moneda)
    VALUES (v_tenant, p_args->>'dispute_id', NULLIF(p_args->>'charge_id',''), v_pago,
            p_args->>'estado', NULLIF(p_args->>'amount','')::integer, p_args->>'moneda')
    ON CONFLICT (tenant_id, dispute_id) DO UPDATE
      SET estado = EXCLUDED.estado,
          pago_id = COALESCE(stripe_disputas.pago_id, EXCLUDED.pago_id),
          actualizado_en = now();
    IF p_args->>'estado' = 'perdida' AND v_pago IS NOT NULL THEN
      v_res := _stripe_compensar(v_tenant, v_pago, NULLIF(p_args->>'amount','')::integer,
        'dp_'||(p_args->>'dispute_id'), 'Contracargo Stripe '||(p_args->>'dispute_id'));
      UPDATE stripe_disputas SET compensado = true, actualizado_en = now()
        WHERE tenant_id = v_tenant AND dispute_id = p_args->>'dispute_id';
    END IF;
    -- 'abierta' → solo persiste (el push lo manda el webhook, best-effort).
    -- 'ganada'  → solo actualiza estado; sin compensación.

  -- ── C1: subscription.updated ── SOLO estado contractual; NUNCA crea cobro. ──
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
  RETURN jsonb_build_object('ok', true, 'kind', p_kind);
END; $$;

-- GRANTs: service_role-only para las funciones nuevas.
REVOKE ALL ON FUNCTION pago_financia_periodo_vigente(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pago_financia_periodo_vigente(uuid) TO service_role;
REVOKE ALL ON FUNCTION _stripe_compensar(uuid,uuid,integer,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _stripe_compensar(uuid,uuid,integer,text,text) TO service_role;
REVOKE ALL ON FUNCTION _stripe_resolver_pago(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _stripe_resolver_pago(text,text,text) TO service_role;

-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenants desechables; cerrar_tenant limpia.
-- ============================================================================
CREATE TEMP TABLE _w6c1_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug  text := 'zz-w6c1-'||substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-w6c1b-'||substr(md5(random()::text),1,6);
  v_t uuid; v_t2 uuid; v_u uuid; v_u2 uuid; v_u3 uuid; v_tier uuid; v_mem uuid; v_pago uuid;
  v_r jsonb; v_ev text; v_sub text := 'sub_'||substr(md5(random()::text),1,8); v_ok boolean;
  v_neg integer; v_fin timestamptz;
BEGIN
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
    VALUES (v_slug,'W6C1','gym_libre','activo','acct_c1','{}'::jsonb) RETURNING id INTO v_t;
  -- un usuario por membresía: `membresias_one_active_per_user` permite 1 activa por socio.
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t,v_slug||'-u1@x.dev','U1','miembro','activo') RETURNING id INTO v_u;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t,v_slug||'-u2@x.dev','U2','miembro','activo') RETURNING id INTO v_u2;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t,v_slug||'-u3@x.dev','U3','miembro','activo') RETURNING id INTO v_u3;
  INSERT INTO tiers (tenant_id,slug,nombre,precio_centavos,tipo,duracion_dias) VALUES (v_t,'c1t','T',50000,'tiempo',30) RETURNING id INTO v_tier;
  INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,stripe_subscription_id)
    VALUES (v_t,v_u,v_tier,'activa',now()-interval '5 days',now()+interval '25 days',v_sub) RETURNING id INTO v_mem;
  INSERT INTO pagos (tenant_id,usuario_id,membresia_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
    VALUES (v_t,v_u,v_mem,v_tier,'plan',50000,'MXN','stripe','pi_charge1') RETURNING id INTO v_pago;

  -- T1: refund PARCIAL → asiento negativo parcial; reembolsable baja
  v_r := _stripe_compensar(v_t, v_pago, 20000, 're_1', 'parcial');
  IF (v_r->>'compensado')::boolean <> true THEN RAISE EXCEPTION 'T1: no compensó'; END IF;
  IF pago_reembolsable(v_pago) <> 30000 THEN RAISE EXCEPTION 'T1: reembolsable != 30000'; END IF;
  INSERT INTO _w6c1_res VALUES (1,'refund parcial: asiento negativo parcial, reembolsable baja','OK');

  -- T2: SEGUNDO refund distinto, mismo charge → segundo asiento
  v_r := _stripe_compensar(v_t, v_pago, 10000, 're_2', 'parcial 2');
  IF pago_reembolsable(v_pago) <> 20000 THEN RAISE EXCEPTION 'T2: reembolsable != 20000'; END IF;
  SELECT count(*) INTO v_neg FROM pagos WHERE revierte_pago_id = v_pago;
  IF v_neg <> 2 THEN RAISE EXCEPTION 'T2: esperaba 2 asientos negativos, hay %', v_neg; END IF;
  INSERT INTO _w6c1_res VALUES (2,'dos refunds distintos (re_1,re_2) mismo charge → 2 asientos','OK');

  -- T3: REPLAY del mismo refund re_1 → idempotente (no crea tercero)
  v_r := _stripe_compensar(v_t, v_pago, 20000, 're_1', 'replay');
  IF (v_r->>'idempotente')::boolean <> true THEN RAISE EXCEPTION 'T3: no detectó replay'; END IF;
  SELECT count(*) INTO v_neg FROM pagos WHERE revierte_pago_id = v_pago;
  IF v_neg <> 2 THEN RAISE EXCEPTION 'T3: replay duplicó (%)', v_neg; END IF;
  INSERT INTO _w6c1_res VALUES (3,'replay del mismo refund.id → idempotente (no duplica)','OK');

  -- T7: REFUND + DISPUTE sobre el mismo pago sin doble compensación.
  --     Quedan 20000 por devolver; una disputa perdida intenta compensar 50000
  --     → se acota a lo disponible; tras agotar, un dispute extra no compensa.
  v_r := _stripe_compensar(v_t, v_pago, 50000, 'dp_dispX', 'contracargo');
  IF (v_r->>'compensado')::boolean <> true OR (v_r->>'monto_centavos')::int <> 20000 THEN RAISE EXCEPTION 'T7: no acotó a 20000'; END IF;
  IF pago_reembolsable(v_pago) <> 0 THEN RAISE EXCEPTION 'T7: reembolsable != 0'; END IF;
  v_r := _stripe_compensar(v_t, v_pago, 50000, 'dp_dispY', 'segundo contracargo');
  IF (v_r->>'compensado')::boolean <> false THEN RAISE EXCEPTION 'T7: compensó de más'; END IF;
  INSERT INTO _w6c1_res VALUES (7,'refund + dispute mismo pago → acotado, sin doble compensación','OK');

  -- T11: OWNERSHIP cross-tenant rechazado
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
    VALUES (v_slug2,'W6C1b','gym_libre','activo','acct_c1b','{}'::jsonb) RETURNING id INTO v_t2;
  v_ok := false;
  BEGIN PERFORM _stripe_resolver_pago('acct_c1b','pi_charge1',NULL);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'STRIPE_OWNERSHIP%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T11: cross-tenant no fue rechazado'; END IF;
  INSERT INTO _w6c1_res VALUES (11,'ownership cross-tenant → RECHAZADO','OK');

  -- Dispatcher end-to-end (con inbox) sobre un pago fresco en otra membresía.
  DECLARE v_mem2 uuid; v_pago2 uuid; v_sub2 text := 'sub2_'||substr(md5(random()::text),1,8);
  BEGIN
    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,stripe_subscription_id)
      VALUES (v_t,v_u2,v_tier,'activa',now()-interval '2 days',now()+interval '28 days',v_sub2) RETURNING id INTO v_mem2;
    INSERT INTO pagos (tenant_id,usuario_id,membresia_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
      VALUES (v_t,v_u2,v_mem2,v_tier,'plan',50000,'MXN','stripe','pi_charge2') RETURNING id INTO v_pago2;

    -- T4: dispute OPEN → WON (sin compensación)
    v_ev := 'evt_'||substr(md5(random()::text),1,8);
    PERFORM _stripe_inbox_receive(v_ev,'socio','charge.dispute.created','acct_c1',v_t,'pi_charge2',now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev);
    PERFORM stripe_procesar_socio(v_ev,'disputa', jsonb_build_object('account_id','acct_c1','dispute_id','dp_won','charge_id','pi_charge2','payment_intent','pi_charge2','estado','abierta','amount',50000,'moneda','mxn'));
    IF (SELECT estado FROM stripe_disputas WHERE tenant_id=v_t AND dispute_id='dp_won') <> 'abierta' THEN RAISE EXCEPTION 'T4: no persistió abierta'; END IF;
    v_ev := 'evt_'||substr(md5(random()::text),1,8);
    PERFORM _stripe_inbox_receive(v_ev,'socio','charge.dispute.closed','acct_c1',v_t,'pi_charge2',now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev);
    PERFORM stripe_procesar_socio(v_ev,'disputa', jsonb_build_object('account_id','acct_c1','dispute_id','dp_won','charge_id','pi_charge2','payment_intent','pi_charge2','estado','ganada','amount',50000,'moneda','mxn'));
    IF (SELECT estado FROM stripe_disputas WHERE tenant_id=v_t AND dispute_id='dp_won') <> 'ganada' THEN RAISE EXCEPTION 'T4: no quedó ganada'; END IF;
    IF (SELECT compensado FROM stripe_disputas WHERE tenant_id=v_t AND dispute_id='dp_won') <> false THEN RAISE EXCEPTION 'T4: ganada compensó (no debía)'; END IF;
    INSERT INTO _w6c1_res VALUES (4,'dispute open→won: persiste, NO compensa','OK');

    -- T5: dispute OPEN → LOST → compensa por dp_ + retira vigencia
    v_ev := 'evt_'||substr(md5(random()::text),1,8);
    PERFORM _stripe_inbox_receive(v_ev,'socio','charge.dispute.created','acct_c1',v_t,'pi_charge2',now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev);
    PERFORM stripe_procesar_socio(v_ev,'disputa', jsonb_build_object('account_id','acct_c1','dispute_id','dp_lost','charge_id','pi_charge2','payment_intent','pi_charge2','estado','abierta','amount',50000,'moneda','mxn'));
    v_ev := 'evt_'||substr(md5(random()::text),1,8);
    PERFORM _stripe_inbox_receive(v_ev,'socio','charge.dispute.closed','acct_c1',v_t,'pi_charge2',now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev);
    PERFORM stripe_procesar_socio(v_ev,'disputa', jsonb_build_object('account_id','acct_c1','dispute_id','dp_lost','charge_id','pi_charge2','payment_intent','pi_charge2','estado','perdida','amount',50000,'moneda','mxn'));
    IF (SELECT count(*) FROM pagos WHERE revierte_pago_id=v_pago2 AND referencia='dp_dp_lost') <> 1 THEN RAISE EXCEPTION 'T5: no compensó la disputa perdida'; END IF;
    IF (SELECT compensado FROM stripe_disputas WHERE tenant_id=v_t AND dispute_id='dp_lost') <> true THEN RAISE EXCEPTION 'T5: no marcó compensado'; END IF;
    SELECT periodo_actual_fin INTO v_fin FROM membresias WHERE id=v_mem2;
    IF v_fin > now() THEN RAISE EXCEPTION 'T5: no retiró vigencia'; END IF;
    INSERT INTO _w6c1_res VALUES (5,'dispute open→lost: compensa por dispute.id + retira vigencia','OK');

    -- T6: REPLAY de la misma disputa perdida → idempotente (no segundo asiento)
    v_ev := 'evt_'||substr(md5(random()::text),1,8);
    PERFORM _stripe_inbox_receive(v_ev,'socio','charge.dispute.closed','acct_c1',v_t,'pi_charge2',now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev);
    PERFORM stripe_procesar_socio(v_ev,'disputa', jsonb_build_object('account_id','acct_c1','dispute_id','dp_lost','charge_id','pi_charge2','payment_intent','pi_charge2','estado','perdida','amount',50000,'moneda','mxn'));
    IF (SELECT count(*) FROM pagos WHERE revierte_pago_id=v_pago2 AND referencia='dp_dp_lost') <> 1 THEN RAISE EXCEPTION 'T6: replay duplicó compensación'; END IF;
    INSERT INTO _w6c1_res VALUES (6,'replay del mismo dispute.id → idempotente','OK');

    -- T8: subscription.updated SIN invoice/payment NO crea movimiento de dinero
    DECLARE v_pagos_antes integer;
    BEGIN
      SELECT count(*) INTO v_pagos_antes FROM pagos WHERE membresia_id=v_mem2;
      v_ev := 'evt_'||substr(md5(random()::text),1,8);
      PERFORM _stripe_inbox_receive(v_ev,'socio','customer.subscription.updated','acct_c1',v_t,v_sub2,now(),'{}');
      PERFORM _stripe_inbox_claim(v_ev);
      PERFORM stripe_procesar_socio(v_ev,'sub_estado', jsonb_build_object('stripe_subscription_id',v_sub2,'nuevo_status','activa','event_created',now()::text,'account_id','acct_c1'));
      IF (SELECT count(*) FROM pagos WHERE membresia_id=v_mem2) <> v_pagos_antes THEN RAISE EXCEPTION 'T8: subscription.updated creó un pago (no debía)'; END IF;
      INSERT INTO _w6c1_res VALUES (8,'subscription.updated sin invoice/payment → 0 movimiento de dinero','OK');
    END;

    -- T9: upgrade con evento económico posterior no duplica. sub_estado (sin
    --     dinero) + luego el cobro real (invoice→activar) asienta UNA sola vez.
    DECLARE v_mem3 uuid; v_sub3 text := 'sub3_'||substr(md5(random()::text),1,8); v_cnt integer;
    BEGIN
      INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,stripe_subscription_id)
        VALUES (v_t,v_u3,v_tier,'activa',now(),now()+interval '30 days',v_sub3) RETURNING id INTO v_mem3;
      v_ev := 'evt_'||substr(md5(random()::text),1,8);
      PERFORM _stripe_inbox_receive(v_ev,'socio','customer.subscription.updated','acct_c1',v_t,v_sub3,now(),'{}');
      PERFORM _stripe_inbox_claim(v_ev);
      PERFORM stripe_procesar_socio(v_ev,'sub_estado', jsonb_build_object('stripe_subscription_id',v_sub3,'nuevo_status','activa','event_created',now()::text,'account_id','acct_c1'));
      -- cobro real del upgrade (referencia única de invoice), idempotente por referencia
      INSERT INTO pagos (tenant_id,usuario_id,membresia_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
        VALUES (v_t,v_u3,v_mem3,v_tier,'plan',70000,'MXN','stripe','in_upgrade1');
      -- reintento del mismo invoice → la unique pagos_referencia_unica lo rechaza
      BEGIN
        INSERT INTO pagos (tenant_id,usuario_id,membresia_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
          VALUES (v_t,v_u3,v_mem3,v_tier,'plan',70000,'MXN','stripe','in_upgrade1');
      EXCEPTION WHEN unique_violation THEN NULL; END;
      SELECT count(*) INTO v_cnt FROM pagos WHERE referencia='in_upgrade1';
      IF v_cnt <> 1 THEN RAISE EXCEPTION 'T9: el cobro del upgrade se duplicó (%)', v_cnt; END IF;
      INSERT INTO _w6c1_res VALUES (9,'upgrade: evento económico posterior asienta 1 sola vez (no duplica)','OK');
    END;
  END;

  -- limpieza (cerrar_tenant prende el flag y borra pagos + cascada).
  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug2);
END $outer$;

-- T10 (contrato/autoridad): stripe_disputas y las RPCs son service_role-only.
DO $$
BEGIN
  IF has_table_privilege('authenticated','stripe_disputas','SELECT')
     OR has_table_privilege('anon','stripe_disputas','SELECT')
     OR has_table_privilege('authenticated','stripe_disputas','INSERT') THEN
    RAISE EXCEPTION 'T10: authenticated/anon tiene acceso directo a stripe_disputas';
  END IF;
  IF has_function_privilege('authenticated','_stripe_compensar(uuid,uuid,integer,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','_stripe_resolver_pago(text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'T10: authenticated puede ejecutar las RPCs económicas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='stripe_aplicar_estado_membresia')
     OR to_regclass('public.stripe_event_inbox') IS NULL THEN
    RAISE EXCEPTION 'T10: A1 ausente (writer/inbox)';
  END IF;
  INSERT INTO _w6c1_res VALUES (10,'autoridad: compensación service_role-only + A1 presente','OK');
END $$;

SELECT orden, prueba, resultado FROM _w6c1_res ORDER BY orden;

COMMIT;
