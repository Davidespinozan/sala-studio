-- ============================================================================
-- W6-C1b — COMPENSACIÓN POR OBJETO STRIPE (hardening de C1)
-- ----------------------------------------------------------------------------
-- Follow-up aditivo de 20261001140000 (que queda intacta como evidencia).
--
-- Dos defectos que corrige:
--  (1) C1 buscaba el pago por referencia = charge/payment_intent, pero las ALTAS
--      guardan la Checkout Session (cs_) y las RENOVACIONES la invoice (in_):
--      un reembolso/contracargo de una membresía no encontraba pago y no se
--      compensaba. Ahora el webhook manda TODAS las referencias del cargo (ch_,
--      pi_, cs_, in_) y el resolver busca por cualquiera.
--  (2) Un objeto Stripe puede financiar VARIOS pagos internos (plan +
--      inscripción, misma referencia). C1 compensaba uno solo (LIMIT 1). Ahora
--      la compensación se reparte sobre todos, sin pasarse de ninguno.
--
-- REGLA DE ASIGNACIÓN (determinista, server-side, reproducible):
--   los pagos positivos del objeto se ordenan por
--     1) concepto: plan/paquete (financian la vigencia) → inscripción → resto
--     2) created_at ASC   3) id ASC
--   y el monto del refund se consume en ese orden hasta agotarse, acotado por lo
--   que le queda por devolver a cada pago (pago_reembolsable).
--   (plan e inscripción nacen en la misma transacción → mismo created_at; por
--   eso el concepto va primero.)
--
-- Idempotencia: por refund.id / 'dp_'+dispute.id. La primera fila negativa lleva
-- esa referencia; si el refund cruza a otro pago, las siguientes llevan
-- '<ref>#2', '#3'… (el índice único es tenant+referencia+concepto). Cada fila
-- negativa apunta a SU pago con revierte_pago_id.
--
-- Invariantes: nunca Σ compensación de un refund > su monto; nunca Σ
-- compensación contra un pago > lo que ese pago tiene por devolver; refund +
-- contracargo del mismo objeto no superan lo cobrado. Append-only (W4), sin
-- _audrec/_op (service_role-safe), atómico. Retiro de vigencia: igual que C1,
-- solo si el pago compensado financió el periodo vigente.
--
-- Las funciones C1 _stripe_compensar/_stripe_resolver_pago quedan definidas pero
-- el dispatcher ya no las usa. Rollback: re-aplicar el stripe_procesar_socio de
-- 20261001140000 + DROP de las 3 funciones nuevas.
-- ============================================================================
BEGIN;

-- ── referencias candidatas del cargo desde los args del evento ─────────────
CREATE OR REPLACE FUNCTION _stripe_refs_de_args(p_args jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::text[]) FROM (
    SELECT jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(p_args->'refs') = 'array' THEN p_args->'refs' ELSE '[]'::jsonb END) AS x
    UNION ALL SELECT p_args->>'charge_id'
    UNION ALL SELECT p_args->>'payment_intent'
  ) q WHERE x IS NOT NULL AND x <> '';
$$;

-- ── resolver TODOS los pagos positivos del objeto, con ownership ───────────
CREATE OR REPLACE FUNCTION _stripe_resolver_pagos(p_account_id text, p_refs text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_ids uuid[];
BEGIN
  v_tenant := _stripe_resolve_tenant(p_account_id);
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'STRIPE_OWNERSHIP: cuenta % sin tenant resoluble', p_account_id; END IF;
  SELECT array_agg(id ORDER BY
           CASE concepto WHEN 'plan' THEN 0 WHEN 'paquete' THEN 0 WHEN 'inscripcion' THEN 1 ELSE 2 END,
           created_at ASC, id ASC)
    INTO v_ids
    FROM pagos
    WHERE tenant_id = v_tenant AND referencia = ANY(p_refs)
      AND concepto <> 'reembolso' AND monto_centavos > 0;
  IF v_ids IS NULL THEN
    -- fail-closed: si ese cargo está asentado en OTRO tenant, es mismatch.
    IF EXISTS (SELECT 1 FROM pagos WHERE referencia = ANY(p_refs) AND concepto <> 'reembolso' AND tenant_id <> v_tenant) THEN
      RAISE EXCEPTION 'STRIPE_OWNERSHIP: el cargo pertenece a otro tenant';
    END IF;
    RETURN jsonb_build_object('tenant', v_tenant, 'pagos', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object('tenant', v_tenant, 'pagos', to_jsonb(v_ids));
END; $$;

-- ── compensación repartida sobre el objeto (núcleo, ATÓMICA) ───────────────
CREATE OR REPLACE FUNCTION _stripe_compensar_objeto(
  p_tenant uuid, p_pagos uuid[], p_monto integer, p_referencia text, p_motivo text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pid uuid; v_pago pagos; v_disp integer := 0; v_rest integer; v_take integer;
  v_n integer := 0; v_total integer; v_retiro boolean := false;
BEGIN
  IF p_referencia IS NULL OR p_referencia = '' THEN RAISE EXCEPTION 'COMP_SIN_REFERENCIA'; END IF;
  IF p_pagos IS NULL OR cardinality(p_pagos) = 0 THEN RAISE EXCEPTION 'COMP_SIN_PAGOS'; END IF;

  -- candado en orden estable (por id) → sin deadlocks entre entregas concurrentes.
  PERFORM 1 FROM pagos WHERE id = ANY(p_pagos) AND tenant_id = p_tenant ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM pagos WHERE id = ANY(p_pagos) AND tenant_id = p_tenant AND concepto <> 'reembolso')
     <> cardinality(p_pagos) THEN
    RAISE EXCEPTION 'COMP_PAGO_INEXISTENTE';
  END IF;

  -- idempotente por refund.id / dispute.id (fila base o sus partes '#n').
  IF EXISTS (
    SELECT 1 FROM pagos
    WHERE tenant_id = p_tenant AND concepto = 'reembolso'
      AND (referencia = p_referencia OR left(referencia, length(p_referencia) + 1) = p_referencia || '#')
  ) THEN
    RETURN jsonb_build_object('compensado', true, 'idempotente', true);
  END IF;

  FOREACH v_pid IN ARRAY p_pagos LOOP v_disp := v_disp + COALESCE(pago_reembolsable(v_pid), 0); END LOOP;
  v_rest := LEAST(COALESCE(p_monto, v_disp), v_disp);   -- nunca más de lo que queda por devolver
  IF v_rest <= 0 THEN
    RETURN jsonb_build_object('compensado', false, 'reason', 'nada_que_compensar', 'disponible', v_disp);
  END IF;
  v_total := v_rest;

  FOREACH v_pid IN ARRAY p_pagos LOOP     -- p_pagos ya viene en el orden de la regla
    EXIT WHEN v_rest <= 0;
    v_take := LEAST(v_rest, COALESCE(pago_reembolsable(v_pid), 0));
    CONTINUE WHEN v_take <= 0;
    SELECT * INTO v_pago FROM pagos WHERE id = v_pid;
    v_n := v_n + 1;
    INSERT INTO pagos (
      tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
      concepto, monto_centavos, moneda, metodo, referencia, notas, cobrado_por, revierte_pago_id
    ) VALUES (
      p_tenant, v_pago.sucursal_id, v_pago.usuario_id, v_pago.membresia_id, v_pago.tier_id,
      'reembolso', -v_take, v_pago.moneda, 'stripe',
      CASE WHEN v_n = 1 THEN p_referencia ELSE p_referencia || '#' || v_n END,
      p_motivo, NULL, v_pid
    );
    IF pago_financia_periodo_vigente(v_pid) THEN
      UPDATE membresias SET periodo_actual_fin = now()
        WHERE id = v_pago.membresia_id AND periodo_actual_fin > now();
      v_retiro := true;
    END IF;
    v_rest := v_rest - v_take;
  END LOOP;

  RETURN jsonb_build_object('compensado', true, 'monto_centavos', v_total, 'filas', v_n, 'retiro_vigencia', v_retiro);
EXCEPTION WHEN unique_violation THEN
  -- carrera: otra entrega del mismo refund/dispute ya lo asentó. Se deshace lo
  -- de ESTA llamada (subtransacción) y se devuelve idempotente.
  RETURN jsonb_build_object('compensado', true, 'idempotente', true);
END; $$;

-- ── dispatcher socio: idéntico a C1 salvo reembolso/disputa por OBJETO ─────
CREATE OR REPLACE FUNCTION stripe_procesar_socio(p_event_id text, p_kind text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res jsonb; v_rp jsonb; v_tenant uuid; v_ref jsonb;
  v_pagos uuid[]; v_refs text[]; v_sin_pago boolean := false;
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

  -- ── C1b: REEMBOLSO ── por OBJETO Stripe: todos los pagos internos que ese
  --    cargo financió (plan + inscripción), cada refund por su refund.id. ──
  ELSIF p_kind = 'reembolso' THEN
    v_refs := _stripe_refs_de_args(p_args);
    v_rp := _stripe_resolver_pagos(p_args->>'account_id', v_refs);
    v_tenant := (v_rp->>'tenant')::uuid;
    v_pagos := ARRAY(SELECT jsonb_array_elements_text(v_rp->'pagos'))::uuid[];
    IF cardinality(v_pagos) > 0 THEN
      -- orden determinista de los refunds: por fecha de creación y luego por id.
      FOR v_ref IN
        SELECT r FROM jsonb_array_elements(COALESCE(p_args->'refunds','[]'::jsonb)) AS r
        ORDER BY NULLIF(r->>'created','')::bigint NULLS LAST, r->>'refund_id'
      LOOP
        PERFORM _stripe_compensar_objeto(v_tenant, v_pagos,
          NULLIF(v_ref->>'amount','')::integer, v_ref->>'refund_id',
          'Reembolso Stripe '||(v_ref->>'refund_id'));
      END LOOP;
    ELSE
      v_sin_pago := true;   -- el cargo no tiene contraparte interna: se reporta, no se inventa
    END IF;

  -- ── C1b: DISPUTA ── open=persistir; won=cerrar; lost=compensar el OBJETO. ──
  ELSIF p_kind = 'disputa' THEN
    v_refs := _stripe_refs_de_args(p_args);
    v_rp := _stripe_resolver_pagos(p_args->>'account_id', v_refs);
    v_tenant := (v_rp->>'tenant')::uuid;
    v_pagos := ARRAY(SELECT jsonb_array_elements_text(v_rp->'pagos'))::uuid[];
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
  RETURN jsonb_build_object('ok', true, 'kind', p_kind, 'sin_pago', v_sin_pago);
END; $$;

REVOKE ALL ON FUNCTION _stripe_refs_de_args(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _stripe_refs_de_args(jsonb) TO service_role;
REVOKE ALL ON FUNCTION _stripe_resolver_pagos(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _stripe_resolver_pagos(text, text[]) TO service_role;
REVOKE ALL ON FUNCTION _stripe_compensar_objeto(uuid, uuid[], integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _stripe_compensar_objeto(uuid, uuid[], integer, text, text) TO service_role;

-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenants desechables.
-- Convención de hygiene: este self-test SÍ escribe stripe_event_inbox → se borra
-- por account_id ANTES de cerrar_tenant (su FK tenant_id es SET NULL).
-- ============================================================================
CREATE TEMP TABLE _w6c1b_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug  text := 'zz-w6h1-'||substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-w6h1b-'||substr(md5(random()::text),1,6);
  v_t uuid; v_t2 uuid; v_tier uuid; v_x uuid; i int;
  v_u    uuid[] := array_fill(NULL::uuid, ARRAY[8]);
  v_m    uuid[] := array_fill(NULL::uuid, ARRAY[8]);
  v_plan uuid[] := array_fill(NULL::uuid, ARRAY[8]);
  v_insc uuid[] := array_fill(NULL::uuid, ARRAY[8]);
  -- 1 plan solo · 2 inscripción sola · 3..7 plan+inscripción · 8 pago único por pi_
  v_ref text[] := ARRAY['cs_h1','cs_h2','cs_h3','cs_h4','cs_h5','cs_h6','cs_h7','pi_h8'];
  v_r jsonb; v_ev text; v_ok boolean; v_n integer; v_ids uuid[]; v_fin timestamptz;
BEGIN
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
    VALUES (v_slug,'W6H1','gym_libre','activo','acct_h1','{}'::jsonb) RETURNING id INTO v_t;
  INSERT INTO tenants (slug,nombre,vertical,status,stripe_account_id,config)
    VALUES (v_slug2,'W6H1b','gym_libre','activo','acct_h1b','{}'::jsonb) RETURNING id INTO v_t2;
  INSERT INTO tiers (tenant_id,slug,nombre,precio_centavos,tipo,duracion_dias) VALUES (v_t,'h1t','T',50000,'tiempo',30) RETURNING id INTO v_tier;

  -- plan e inscripción se insertan en la MISMA transacción (mismo created_at),
  -- igual que en producción: el desempate de la regla es el concepto.
  FOR i IN 1..8 LOOP
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t,v_slug||'-u'||i||'@x.dev','U'||i,'miembro','activo') RETURNING id INTO v_x;
    v_u[i] := v_x;
    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,stripe_subscription_id)
      VALUES (v_t,v_u[i],v_tier,'activa',now()-interval '2 days',now()+interval '28 days','sub_h'||i) RETURNING id INTO v_x;
    v_m[i] := v_x;
    IF i IN (2,3,4,5,6,7) THEN   -- la inscripción se inserta PRIMERO a propósito: el orden físico no manda
      INSERT INTO pagos (tenant_id,usuario_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
        VALUES (v_t,v_u[i],v_tier,'inscripcion',30000,'MXN','stripe',v_ref[i]) RETURNING id INTO v_x;
      v_insc[i] := v_x;
    END IF;
    IF i <> 2 THEN
      INSERT INTO pagos (tenant_id,usuario_id,membresia_id,tier_id,concepto,monto_centavos,moneda,metodo,referencia)
        VALUES (v_t,v_u[i],v_m[i],v_tier,'plan',50000,'MXN','stripe',v_ref[i]) RETURNING id INTO v_x;
      v_plan[i] := v_x;
    END IF;
  END LOOP;

  -- T1: plan solo, refund total
  v_ids := ARRAY(SELECT jsonb_array_elements_text(_stripe_resolver_pagos('acct_h1', ARRAY['ch_x','pi_x','cs_h1'])->'pagos'))::uuid[];
  IF v_ids <> ARRAY[v_plan[1]] THEN RAISE EXCEPTION 'T1: resolver'; END IF;
  v_r := _stripe_compensar_objeto(v_t, v_ids, 50000, 're_h1', 't1');
  IF pago_reembolsable(v_plan[1]) <> 0 OR (v_r->>'filas')::int <> 1 THEN RAISE EXCEPTION 'T1: no compensó el plan completo'; END IF;
  SELECT periodo_actual_fin INTO v_fin FROM membresias WHERE id = v_m[1];
  IF v_fin > now() THEN RAISE EXCEPTION 'T1: no retiró vigencia'; END IF;
  INSERT INTO _w6c1b_res VALUES (1,'plan solo: refund total compensa el plan (por cs_) y retira vigencia','OK');

  -- T2: inscripción sola, refund total (no toca vigencia)
  v_ids := ARRAY(SELECT jsonb_array_elements_text(_stripe_resolver_pagos('acct_h1', ARRAY['cs_h2'])->'pagos'))::uuid[];
  v_r := _stripe_compensar_objeto(v_t, v_ids, 30000, 're_h2', 't2');
  IF pago_reembolsable(v_insc[2]) <> 0 OR (v_r->>'retiro_vigencia')::boolean THEN RAISE EXCEPTION 'T2: inscripción sola'; END IF;
  SELECT periodo_actual_fin INTO v_fin FROM membresias WHERE id = v_m[2];
  IF v_fin <= now() THEN RAISE EXCEPTION 'T2: retiró vigencia por una inscripción'; END IF;
  INSERT INTO _w6c1b_res VALUES (2,'inscripción sola: refund total, sin retiro de vigencia','OK');

  -- T3: plan + inscripción, refund TOTAL vía DISPATCHER (referencia cs_ en refs)
  v_ev := 'evt_'||substr(md5(random()::text),1,8);
  PERFORM _stripe_inbox_receive(v_ev,'socio','charge.refunded','acct_h1',v_t,'ch_h3',now(),'{}');
  PERFORM _stripe_inbox_claim(v_ev);
  v_r := stripe_procesar_socio(v_ev,'reembolso', jsonb_build_object('account_id','acct_h1','charge_id','ch_h3','payment_intent','pi_h3',
    'refs', jsonb_build_array('ch_h3','pi_h3','cs_h3'),
    'refunds', jsonb_build_array(jsonb_build_object('refund_id','re_h3','amount',80000,'created',1))));
  IF (v_r->>'sin_pago')::boolean THEN RAISE EXCEPTION 'T3: no resolvió el objeto por cs_'; END IF;
  IF (SELECT monto_centavos FROM pagos WHERE tenant_id=v_t AND referencia='re_h3'   AND revierte_pago_id=v_plan[3]) IS DISTINCT FROM -50000 THEN RAISE EXCEPTION 'T3: parte del plan'; END IF;
  IF (SELECT monto_centavos FROM pagos WHERE tenant_id=v_t AND referencia='re_h3#2' AND revierte_pago_id=v_insc[3]) IS DISTINCT FROM -30000 THEN RAISE EXCEPTION 'T3: parte de la inscripción'; END IF;
  IF pago_reembolsable(v_plan[3]) <> 0 OR pago_reembolsable(v_insc[3]) <> 0 THEN RAISE EXCEPTION 'T3: quedó saldo sin compensar'; END IF;
  IF (SELECT estado FROM stripe_event_inbox WHERE id=v_ev) <> 'processed' THEN RAISE EXCEPTION 'T3: inbox no processed'; END IF;
  INSERT INTO _w6c1b_res VALUES (3,'plan + inscripción: refund total compensa A + B (dispatcher, por cs_)','OK');

  -- T4: parcial MENOR que la primera asignación → solo el plan
  v_ids := ARRAY(SELECT jsonb_array_elements_text(_stripe_resolver_pagos('acct_h1', ARRAY['cs_h4'])->'pagos'))::uuid[];
  IF v_ids <> ARRAY[v_plan[4], v_insc[4]] THEN RAISE EXCEPTION 'T4: orden de la regla (plan primero) no se cumple'; END IF;
  v_r := _stripe_compensar_objeto(v_t, v_ids, 20000, 're_h4', 't4');
  IF pago_reembolsable(v_plan[4]) <> 30000 OR pago_reembolsable(v_insc[4]) <> 30000 OR (v_r->>'filas')::int <> 1 THEN RAISE EXCEPTION 'T4: parcial chico'; END IF;
  INSERT INTO _w6c1b_res VALUES (4,'parcial menor que la 1ª asignación → solo el plan (orden determinista)','OK');

  -- T5: parcial que CRUZA del plan a la inscripción
  v_ids := ARRAY(SELECT jsonb_array_elements_text(_stripe_resolver_pagos('acct_h1', ARRAY['cs_h5'])->'pagos'))::uuid[];
  v_r := _stripe_compensar_objeto(v_t, v_ids, 60000, 're_h5', 't5');
  IF pago_reembolsable(v_plan[5]) <> 0 OR pago_reembolsable(v_insc[5]) <> 20000 THEN RAISE EXCEPTION 'T5: cruce'; END IF;
  IF (SELECT monto_centavos FROM pagos WHERE tenant_id=v_t AND referencia='re_h5#2' AND revierte_pago_id=v_insc[5]) IS DISTINCT FROM -10000 THEN RAISE EXCEPTION 'T5: fila #2'; END IF;
  INSERT INTO _w6c1b_res VALUES (5,'parcial que cruza: agota el plan y sigue en la inscripción','OK');

  -- T6: varios parciales hasta el total
  v_ids := ARRAY(SELECT jsonb_array_elements_text(_stripe_resolver_pagos('acct_h1', ARRAY['cs_h6'])->'pagos'))::uuid[];
  PERFORM _stripe_compensar_objeto(v_t, v_ids, 20000, 're_h6a', 't6');
  PERFORM _stripe_compensar_objeto(v_t, v_ids, 40000, 're_h6b', 't6');
  PERFORM _stripe_compensar_objeto(v_t, v_ids, 20000, 're_h6c', 't6');
  IF pago_reembolsable(v_plan[6]) <> 0 OR pago_reembolsable(v_insc[6]) <> 0 THEN RAISE EXCEPTION 'T6: no llegó al total'; END IF;
  IF (SELECT SUM(monto_centavos) FROM pagos WHERE revierte_pago_id IN (v_plan[6], v_insc[6])) <> -80000 THEN RAISE EXCEPTION 'T6: suma'; END IF;
  INSERT INTO _w6c1b_res VALUES (6,'múltiples parciales (20k+40k+20k) llegan exacto al total','OK');

  -- T7: mismo refund.id otra vez → idempotente (incluye el que se partió en #2)
  v_ids := ARRAY(SELECT jsonb_array_elements_text(_stripe_resolver_pagos('acct_h1', ARRAY['cs_h5'])->'pagos'))::uuid[];
  v_r := _stripe_compensar_objeto(v_t, v_ids, 60000, 're_h5', 't7');
  IF NOT COALESCE((v_r->>'idempotente')::boolean,false) THEN RAISE EXCEPTION 'T7: no detectó duplicado'; END IF;
  IF (SELECT count(*) FROM pagos WHERE revierte_pago_id IN (v_plan[5], v_insc[5])) <> 2 THEN RAISE EXCEPTION 'T7: duplicó filas'; END IF;
  INSERT INTO _w6c1b_res VALUES (7,'mismo refund.id repetido → idempotente (no duplica)','OK');

  -- T8: refund MAYOR que lo que queda → se acota; el siguiente no compensa
  v_ids := ARRAY(SELECT jsonb_array_elements_text(_stripe_resolver_pagos('acct_h1', ARRAY['cs_h4'])->'pagos'))::uuid[];
  v_r := _stripe_compensar_objeto(v_t, v_ids, 99999, 're_h4b', 't8');
  IF (v_r->>'monto_centavos')::int <> 60000 THEN RAISE EXCEPTION 'T8: no acotó a 60000'; END IF;
  v_r := _stripe_compensar_objeto(v_t, v_ids, 100, 're_h4c', 't8');
  IF (v_r->>'compensado')::boolean THEN RAISE EXCEPTION 'T8: compensó de más'; END IF;
  INSERT INTO _w6c1b_res VALUES (8,'refund mayor que lo restante → acotado; el siguiente no compensa','OK');

  -- T9: refund + contracargo PERDIDO del mismo objeto → tope económico
  v_ids := ARRAY(SELECT jsonb_array_elements_text(_stripe_resolver_pagos('acct_h1', ARRAY['cs_h7'])->'pagos'))::uuid[];
  PERFORM _stripe_compensar_objeto(v_t, v_ids, 60000, 're_h7', 't9');
  v_ev := 'evt_'||substr(md5(random()::text),1,8);
  PERFORM _stripe_inbox_receive(v_ev,'socio','charge.dispute.closed','acct_h1',v_t,'dp_h7',now(),'{}');
  PERFORM _stripe_inbox_claim(v_ev);
  PERFORM stripe_procesar_socio(v_ev,'disputa', jsonb_build_object('account_id','acct_h1','dispute_id','h7','charge_id','ch_h7','payment_intent','pi_h7',
    'refs', jsonb_build_array('ch_h7','pi_h7','cs_h7'),'estado','perdida','amount',80000,'moneda','mxn'));
  IF (SELECT SUM(monto_centavos) FROM pagos WHERE revierte_pago_id IN (v_plan[7], v_insc[7])) <> -80000 THEN RAISE EXCEPTION 'T9: refund + contracargo no cuadran en 80000'; END IF;
  IF (SELECT monto_centavos FROM pagos WHERE tenant_id=v_t AND referencia='dp_h7') IS DISTINCT FROM -20000 THEN RAISE EXCEPTION 'T9: el contracargo no se acotó a 20000'; END IF;
  IF NOT (SELECT compensado FROM stripe_disputas WHERE tenant_id=v_t AND dispute_id='h7') THEN RAISE EXCEPTION 'T9: disputa sin marcar'; END IF;
  INSERT INTO _w6c1b_res VALUES (9,'refund + contracargo perdido mismo objeto → nunca más que lo cobrado','OK');

  -- T13: pago ÚNICO por pi_ vía dispatcher SIN refs (compatibilidad C1)
  v_ev := 'evt_'||substr(md5(random()::text),1,8);
  PERFORM _stripe_inbox_receive(v_ev,'socio','charge.refunded','acct_h1',v_t,'ch_h8',now(),'{}');
  PERFORM _stripe_inbox_claim(v_ev);
  PERFORM stripe_procesar_socio(v_ev,'reembolso', jsonb_build_object('account_id','acct_h1','charge_id','ch_h8','payment_intent','pi_h8',
    'refunds', jsonb_build_array(jsonb_build_object('refund_id','re_h8','amount',20000))));
  IF (SELECT monto_centavos FROM pagos WHERE tenant_id=v_t AND referencia='re_h8' AND revierte_pago_id=v_plan[8]) IS DISTINCT FROM -20000 THEN RAISE EXCEPTION 'T13: pago único'; END IF;
  IF pago_reembolsable(v_plan[8]) <> 30000 THEN RAISE EXCEPTION 'T13: reembolsable'; END IF;
  INSERT INTO _w6c1b_res VALUES (13,'pago único por pi_ (sin refs): comportamiento C1 intacto','OK');

  -- T10: sin sobrecompensación en NINGÚN pago del tenant
  IF EXISTS (
    SELECT 1 FROM pagos p WHERE p.tenant_id = v_t AND p.concepto <> 'reembolso'
      AND (SELECT COALESCE(SUM(-r.monto_centavos),0) FROM pagos r WHERE r.revierte_pago_id = p.id) > p.monto_centavos
  ) THEN RAISE EXCEPTION 'T10: hay un pago sobrecompensado'; END IF;
  INSERT INTO _w6c1b_res VALUES (10,'ningún pago compensado por más de su monto','OK');

  -- T11: cada fila negativa apunta a un pago positivo del mismo tenant
  IF EXISTS (
    SELECT 1 FROM pagos n WHERE n.tenant_id = v_t AND n.concepto = 'reembolso'
      AND NOT EXISTS (SELECT 1 FROM pagos p WHERE p.id = n.revierte_pago_id AND p.tenant_id = v_t AND p.concepto <> 'reembolso')
  ) THEN RAISE EXCEPTION 'T11: reembolso sin pago origen válido'; END IF;
  INSERT INTO _w6c1b_res VALUES (11,'revierte_pago_id correcto en cada fila negativa','OK');

  -- T12: CONSERVACIÓN ECONÓMICA por objeto: Σ(positivos + negativos) = cobrado − compensado
  FOR i IN 1..8 LOOP
    SELECT COALESCE(SUM(x.monto_centavos),0) INTO v_n FROM (
      SELECT monto_centavos FROM pagos WHERE tenant_id=v_t AND referencia=v_ref[i] AND concepto<>'reembolso'
      UNION ALL
      SELECT r.monto_centavos FROM pagos r WHERE r.revierte_pago_id IN (SELECT id FROM pagos WHERE tenant_id=v_t AND referencia=v_ref[i] AND concepto<>'reembolso')
    ) x;
    IF v_n < 0 THEN RAISE EXCEPTION 'T12: objeto % quedó en negativo (%)', v_ref[i], v_n; END IF;
    IF i IN (1,2,3,4,6,7) AND v_n <> 0 THEN RAISE EXCEPTION 'T12: objeto % debía quedar en 0, quedó %', v_ref[i], v_n; END IF;
    IF i = 5 AND v_n <> 20000 THEN RAISE EXCEPTION 'T12: objeto 5 debía quedar en 20000, quedó %', v_n; END IF;
    IF i = 8 AND v_n <> 30000 THEN RAISE EXCEPTION 'T12: objeto 8 debía quedar en 30000, quedó %', v_n; END IF;
  END LOOP;
  INSERT INTO _w6c1b_res VALUES (12,'conservación económica por objeto (neto = cobrado − compensado, nunca < 0)','OK');

  -- T14: ownership — el cargo de este tenant pedido con la cuenta de OTRO → rechazo
  v_ok := false;
  BEGIN PERFORM _stripe_resolver_pagos('acct_h1b', ARRAY['cs_h3']);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'STRIPE_OWNERSHIP%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T14: cross-tenant no rechazado'; END IF;
  INSERT INTO _w6c1b_res VALUES (14,'ownership cross-tenant → RECHAZADO','OK');

  -- T15: cargo sin contraparte interna → sin_pago=true, no inventa nada, processed
  v_ev := 'evt_'||substr(md5(random()::text),1,8);
  PERFORM _stripe_inbox_receive(v_ev,'socio','charge.refunded','acct_h1',v_t,'ch_nada',now(),'{}');
  PERFORM _stripe_inbox_claim(v_ev);
  v_r := stripe_procesar_socio(v_ev,'reembolso', jsonb_build_object('account_id','acct_h1','charge_id','ch_nada','payment_intent','pi_nada',
    'refunds', jsonb_build_array(jsonb_build_object('refund_id','re_nada','amount',1000))));
  IF NOT (v_r->>'sin_pago')::boolean THEN RAISE EXCEPTION 'T15: no avisó sin_pago'; END IF;
  IF EXISTS (SELECT 1 FROM pagos WHERE tenant_id=v_t AND referencia='re_nada') THEN RAISE EXCEPTION 'T15: inventó una compensación'; END IF;
  INSERT INTO _w6c1b_res VALUES (15,'cargo sin pago interno → sin_pago (se reporta, no se inventa)','OK');

  -- limpieza: inbox por account_id ANTES de cerrar_tenant (convención C1).
  DELETE FROM stripe_event_inbox WHERE account_id IN ('acct_h1','acct_h1b');
  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug2);
END $outer$;

DO $$
BEGIN
  IF has_function_privilege('authenticated','_stripe_compensar_objeto(uuid,uuid[],integer,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','_stripe_resolver_pagos(text,text[])','EXECUTE')
     OR has_function_privilege('anon','_stripe_compensar_objeto(uuid,uuid[],integer,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'T16: el cliente puede ejecutar las funciones económicas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='stripe_aplicar_estado_membresia')
     OR to_regclass('public.stripe_event_inbox') IS NULL
     OR to_regclass('public.stripe_disputas') IS NULL THEN
    RAISE EXCEPTION 'T16: A1/C1 ausentes';
  END IF;
  INSERT INTO _w6c1b_res VALUES (16,'autoridad service_role-only + A1/C1 presentes','OK');
END $$;

SELECT orden, prueba, resultado FROM _w6c1b_res ORDER BY orden;

COMMIT;
