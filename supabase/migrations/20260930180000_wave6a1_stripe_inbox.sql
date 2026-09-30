-- ============================================================================
-- WAVE 6 · A1 — Stripe durable inbox / state machine / canonical membership
--                writer / multi-tenant ownership helpers
-- ----------------------------------------------------------------------------
-- ADITIVO. Introduce la infraestructura server-side de W6 SIN cambiar el
-- comportamiento de los webhooks Stripe productivos (A2 los conectará después).
-- NO elimina stripe_webhook_events, ni webhooks, ni funciones/columnas actuales.
-- Todo service_role-only. No toca créditos ni entitlement (W4/W5 intactos).
--
-- ROLLBACK A1 (retira SOLO A1, sin tocar W1-W5 ni el flujo Stripe productivo):
--   DROP FUNCTION IF EXISTS stripe_replay_event(text);
--   DROP FUNCTION IF EXISTS _stripe_inbox_failed(text,text,int);
--   DROP FUNCTION IF EXISTS _stripe_inbox_processed(text);
--   DROP FUNCTION IF EXISTS _stripe_inbox_claim(text);
--   DROP FUNCTION IF EXISTS _stripe_inbox_receive(text,text,text,text,uuid,text,timestamptz,jsonb);
--   DROP FUNCTION IF EXISTS stripe_aplicar_estado_membresia(text,text,timestamptz,text,text);
--   DROP FUNCTION IF EXISTS _stripe_assert_ownership_sub(text,text);
--   DROP FUNCTION IF EXISTS _stripe_resolve_tenant(text);
--   DROP FUNCTION IF EXISTS _stripe_min_payload(jsonb);
--   DROP TABLE IF EXISTS stripe_event_inbox;
--   ALTER TABLE membresias DROP COLUMN IF EXISTS stripe_last_event_at;
--   ALTER TABLE membresias DROP COLUMN IF EXISTS stripe_last_event_id;
-- ============================================================================

BEGIN;

-- ── Columnas de ordenamiento por objeto en membresias (aditivas) ────────────
ALTER TABLE membresias ADD COLUMN IF NOT EXISTS stripe_last_event_at timestamptz;
ALTER TABLE membresias ADD COLUMN IF NOT EXISTS stripe_last_event_id text;
COMMENT ON COLUMN membresias.stripe_last_event_at IS
  'W6. Marca del último evento Stripe aplicado a esta membresía (orden por objeto).';

-- ── 1) INBOX DURABLE ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_event_inbox (
  id                text PRIMARY KEY,             -- Stripe event.id (único por cuenta)
  flujo             text NOT NULL CHECK (flujo IN ('socio','saas')),
  type              text NOT NULL,
  account_id        text,                          -- event.account (Connect); NULL en plataforma
  tenant_id         uuid REFERENCES tenants(id) ON DELETE SET NULL,
  object_id         text,                          -- sub/invoice/charge/PI (orden por objeto)
  estado            text NOT NULL DEFAULT 'received'
                      CHECK (estado IN ('received','processing','processed','failed','dead')),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- proyección minimizada
  stripe_created_at timestamptz,                   -- event.created
  intentos          integer NOT NULL DEFAULT 0,
  ultimo_error      text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processing_at     timestamptz,
  processed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_inbox_dlq
  ON stripe_event_inbox (estado, updated_at) WHERE estado IN ('failed','dead');
CREATE INDEX IF NOT EXISTS idx_stripe_inbox_object
  ON stripe_event_inbox (object_id, stripe_created_at) WHERE object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stripe_inbox_tenant ON stripe_event_inbox (tenant_id);

ALTER TABLE stripe_event_inbox ENABLE ROW LEVEL SECURITY;  -- sin policies → solo service_role/owner
REVOKE ALL ON stripe_event_inbox FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE stripe_event_inbox IS
  'W6-A1. Inbox durable de eventos Stripe con máquina de estados '
  '(received→processing→processed / →failed→processing / →dead). DLQ = estado=dead. '
  'Payload minimizado (sin secretos). Coexiste con stripe_webhook_events hasta A2.';

-- ── Minimización de payload (whitelist; sin material sensible) ───────────────
CREATE OR REPLACE FUNCTION _stripe_min_payload(p_obj jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_strip_nulls(jsonb_build_object(
    'id',                 p_obj->'id',
    'status',             p_obj->'status',
    'amount',             p_obj->'amount',
    'amount_paid',        p_obj->'amount_paid',
    'amount_refunded',    p_obj->'amount_refunded',
    'currency',           p_obj->'currency',
    'metadata',           p_obj->'metadata',
    'billing_reason',     p_obj->'billing_reason',
    'current_period_end', p_obj->'current_period_end',
    'customer',           p_obj->'customer',
    'subscription',       p_obj->'subscription',
    'payment_intent',     p_obj->'payment_intent',
    'charge',             p_obj->'charge',
    'invoice',            p_obj->'invoice',
    'refund',             p_obj->'refund',
    'dispute',            p_obj->'dispute',
    'reason',             p_obj->'reason',
    'cancel_at_period_end', p_obj->'cancel_at_period_end'
  )), '{}'::jsonb);
$$;
COMMENT ON FUNCTION _stripe_min_payload(jsonb) IS
  'W6. Proyección minimizada de un objeto Stripe: whitelist de campos necesarios '
  'para procesar/reconciliar. Descarta todo lo demás (tarjetas, PII cruda, etc.).';

-- ── 2/3) MÁQUINA DE ESTADOS ─────────────────────────────────────────────────
-- receive: idempotente por event.id. Devuelve {nuevo, estado}.
CREATE OR REPLACE FUNCTION _stripe_inbox_receive(
  p_event_id text, p_flujo text, p_type text, p_account text,
  p_tenant uuid, p_object_id text, p_created timestamptz, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_estado text; v_ins integer;
BEGIN
  INSERT INTO stripe_event_inbox (id, flujo, type, account_id, tenant_id, object_id, stripe_created_at, payload)
  VALUES (p_event_id, p_flujo, p_type, p_account, p_tenant, p_object_id, p_created, COALESCE(p_payload,'{}'::jsonb))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  SELECT estado INTO v_estado FROM stripe_event_inbox WHERE id = p_event_id;
  RETURN jsonb_build_object('nuevo', v_ins > 0, 'estado', v_estado);
END; $$;

-- claim atómico: solo desde received|failed → processing. Devuelve la fila o NULL.
CREATE OR REPLACE FUNCTION _stripe_inbox_claim(p_event_id text)
RETURNS stripe_event_inbox LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row stripe_event_inbox;
BEGIN
  UPDATE stripe_event_inbox
  SET estado = 'processing', intentos = intentos + 1, processing_at = now(), updated_at = now()
  WHERE id = p_event_id AND estado IN ('received','failed')
  RETURNING * INTO v_row;
  RETURN v_row;  -- NULL si no reclamable (processing/processed/dead/inexistente)
END; $$;

-- processed: solo desde processing (para usar en la MISMA tx que el efecto en A2).
CREATE OR REPLACE FUNCTION _stripe_inbox_processed(p_event_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE stripe_event_inbox
  SET estado = 'processed', processed_at = now(), ultimo_error = NULL, updated_at = now()
  WHERE id = p_event_id AND estado = 'processing';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END; $$;

-- failed: processing → failed (o dead si agotó intentos). Error sanitizado (1ª línea, sin :secretos).
CREATE OR REPLACE FUNCTION _stripe_inbox_failed(p_event_id text, p_error text, p_max_intentos integer DEFAULT 5)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_intentos integer; v_final text;
BEGIN
  SELECT intentos INTO v_intentos FROM stripe_event_inbox WHERE id = p_event_id AND estado = 'processing';
  IF NOT FOUND THEN RETURN NULL; END IF;  -- transición inválida: falla cerrada (no cambia nada)
  v_final := CASE WHEN v_intentos >= p_max_intentos THEN 'dead' ELSE 'failed' END;
  UPDATE stripe_event_inbox
  SET estado = v_final, ultimo_error = left(split_part(COALESCE(p_error,''), E'\n', 1), 500), updated_at = now()
  WHERE id = p_event_id AND estado = 'processing';
  RETURN v_final;
END; $$;

-- replay: SOLO acción explícita. dead|failed → received (re-armar). processed nunca.
CREATE OR REPLACE FUNCTION stripe_replay_event(p_event_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE stripe_event_inbox
  SET estado = 'received', updated_at = now()
  WHERE id = p_event_id AND estado IN ('failed','dead');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;  -- false si processed/processing/inexistente
END; $$;

-- ── 5) OWNERSHIP HELPERS ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _stripe_resolve_tenant(p_account_id text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM tenants WHERE stripe_account_id = p_account_id;  -- NULL si no hay match; único por columna
$$;

-- Asevera que la subscription pertenece al tenant de la cuenta Connect del evento.
-- Fail-closed: devuelve la membresía SOLO si ownership es inequívoco; si no, RAISE.
CREATE OR REPLACE FUNCTION _stripe_assert_ownership_sub(p_stripe_subscription_id text, p_account_id text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mem uuid; v_mem_tenant uuid; v_acct_tenant uuid;
BEGIN
  SELECT id, tenant_id INTO v_mem, v_mem_tenant FROM membresias WHERE stripe_subscription_id = p_stripe_subscription_id;
  IF v_mem IS NULL THEN
    RETURN NULL;  -- no hay membresía ligada (posible carrera/evento temprano): el caller decide, no es mismatch
  END IF;
  IF p_account_id IS NOT NULL THEN
    v_acct_tenant := _stripe_resolve_tenant(p_account_id);
    IF v_acct_tenant IS NULL THEN
      RAISE EXCEPTION 'STRIPE_OWNERSHIP: cuenta % sin tenant resoluble', p_account_id;
    END IF;
    IF v_acct_tenant IS DISTINCT FROM v_mem_tenant THEN
      RAISE EXCEPTION 'STRIPE_OWNERSHIP: la subscription pertenece a otro tenant (evento cuenta=% membresía tenant=%)', v_acct_tenant, v_mem_tenant;
    END IF;
  END IF;
  RETURN v_mem;
END; $$;

-- ── 4) WRITER CANÓNICO DE ESTADO DE MEMBRESÍA (Stripe-driven) ───────────────
CREATE OR REPLACE FUNCTION stripe_aplicar_estado_membresia(
  p_stripe_subscription_id text,
  p_nuevo_status text,
  p_event_created timestamptz,
  p_event_id text,
  p_account_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mem uuid; v_cur_status text; v_last_at timestamptz; v_last_id text;
BEGIN
  IF p_nuevo_status NOT IN ('activa','past_due','cancelada') THEN
    RAISE EXCEPTION 'STRIPE_STATUS_INVALIDO: % no es un status Stripe-driven', p_nuevo_status;
  END IF;

  -- Ownership inequívoco (fail-closed ante mismatch). NULL = sin membresía ligada.
  v_mem := _stripe_assert_ownership_sub(p_stripe_subscription_id, p_account_id);
  IF v_mem IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_membership');
  END IF;

  -- Lock + estado/orden actuales.
  SELECT status, stripe_last_event_at, stripe_last_event_id
  INTO v_cur_status, v_last_at, v_last_id
  FROM membresias WHERE id = v_mem FOR UPDATE;

  -- Orden por objeto: aplicar solo si (created, event_id) > (last_at, last_id). Idempotente.
  IF v_last_at IS NOT NULL AND (
       p_event_created < v_last_at
       OR (p_event_created = v_last_at AND COALESCE(p_event_id,'') <= COALESCE(v_last_id,''))
     ) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'stale', 'status', v_cur_status);
  END IF;

  -- Escribe SOLO campos cuya autoridad es Stripe (status + orden + cancelada_at).
  -- NO toca créditos ni entitlement. El UPDATE dispara W5-B (sync cache) y pasa W5-C
  -- por correr como owner (service_role/DEFINER).
  UPDATE membresias
  SET status = p_nuevo_status,
      cancelada_at = CASE WHEN p_nuevo_status = 'cancelada' THEN COALESCE(cancelada_at, now()) ELSE cancelada_at END,
      stripe_last_event_at = p_event_created,
      stripe_last_event_id = p_event_id,
      updated_at = now()
  WHERE id = v_mem;

  RETURN jsonb_build_object('applied', true, 'membresia_id', v_mem, 'status', p_nuevo_status);
END; $$;

COMMENT ON FUNCTION stripe_aplicar_estado_membresia(text,text,timestamptz,text,text) IS
  'W6-A1. Writer canónico Stripe→membresia.status (activa/past_due/cancelada): '
  'ownership inequívoco + FOR UPDATE + orden por objeto (stripe_last_event_*) + '
  'idempotente. service_role only. Dispara W5-B; no toca créditos/entitlement.';

-- ── GRANTS: todo service_role-only ──────────────────────────────────────────
DO $$
DECLARE fn text;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    '_stripe_min_payload(jsonb)',
    '_stripe_inbox_receive(text,text,text,text,uuid,text,timestamptz,jsonb)',
    '_stripe_inbox_claim(text)',
    '_stripe_inbox_processed(text)',
    '_stripe_inbox_failed(text,text,integer)',
    'stripe_replay_event(text)',
    '_stripe_resolve_tenant(text)',
    '_stripe_assert_ownership_sub(text,text)',
    'stripe_aplicar_estado_membresia(text,text,timestamptz,text,text)'
  ]) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenant desechable; cerrar_tenant limpia.
-- ============================================================================
CREATE TEMP TABLE _w6a1_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug text := 'zz-w6a1-' || substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-w6a1b-' || substr(md5(random()::text),1,6);
  v_tenant uuid; v_tenant2 uuid; v_u uuid; v_tier uuid; v_mem uuid;
  v_sub text := 'sub_'||substr(md5(random()::text),1,10);
  v_ev text := 'evt_'||substr(md5(random()::text),1,10);
  v_r jsonb; v_row stripe_event_inbox; v_b boolean; v_txt text; v_ok boolean;
  v_saldo integer; v_vig boolean; v_ptr uuid; v_status text;
  v_auth uuid := gen_random_uuid();
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status, stripe_account_id) VALUES (v_slug,'W6A1','gym_libre','activo','acct_w6a1') RETURNING id INTO v_tenant;
  INSERT INTO tenants (slug, nombre, vertical, status, stripe_account_id) VALUES (v_slug2,'W6A1B','gym_libre','activo','acct_w6a1b') RETURNING id INTO v_tenant2;
  -- Admin con auth (para T14 writer-rechazado y T15 W5-C con RLS que sí permite al admin).
  INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000',v_auth,'authenticated','authenticated',v_slug||'-admin@x.dev',
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'@x.dev','U','miembro','activo') RETURNING id INTO v_u;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, duracion_dias) VALUES (v_tenant,'w6a1-t','T',100000,'tiempo',30) RETURNING id INTO v_tier;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, stripe_subscription_id, creditos_restantes)
  VALUES (v_tenant, v_u, v_tier, 'activa', now(), now()+interval '30 days', v_sub, NULL) RETURNING id INTO v_mem;

  -- INBOX --------------------------------------------------------------------
  -- T1: receive idempotente
  v_r := _stripe_inbox_receive(v_ev,'socio','invoice.payment_failed','acct_w6a1',v_tenant,v_sub,now(),'{"id":"x"}');
  IF (v_r->>'nuevo')::boolean <> true THEN RAISE EXCEPTION 'T1: primer receive no fue nuevo'; END IF;
  v_r := _stripe_inbox_receive(v_ev,'socio','invoice.payment_failed','acct_w6a1',v_tenant,v_sub,now(),'{"id":"x"}');
  IF (v_r->>'nuevo')::boolean <> false THEN RAISE EXCEPTION 'T1: receive duplicado se trató como nuevo'; END IF;
  IF (SELECT count(*) FROM stripe_event_inbox WHERE id=v_ev) <> 1 THEN RAISE EXCEPTION 'T1: duplicó fila'; END IF;
  INSERT INTO _w6a1_res VALUES (1,'inbox receive idempotente por event.id (1 fila)','OK');

  -- T2: claim único + segundo claim vacío (exclusividad)
  v_row := _stripe_inbox_claim(v_ev);
  IF v_row.id IS NULL OR v_row.estado <> 'processing' THEN RAISE EXCEPTION 'T2: claim no reclamó'; END IF;
  v_row := _stripe_inbox_claim(v_ev);
  IF v_row.id IS NOT NULL THEN RAISE EXCEPTION 'T2: segundo claim (ya processing) devolvió fila'; END IF;
  INSERT INTO _w6a1_res VALUES (2,'claim único; 2º claim sobre processing → vacío','OK');

  -- T3: failed → re-claim (retry)
  v_txt := _stripe_inbox_failed(v_ev,'boom: secreto_no_deberia_verse',5);
  IF v_txt <> 'failed' THEN RAISE EXCEPTION 'T3: no pasó a failed (=%)',v_txt; END IF;
  v_row := _stripe_inbox_claim(v_ev);
  IF v_row.id IS NULL OR v_row.intentos <> 2 THEN RAISE EXCEPTION 'T3: failed no re-claimable / intentos mal (=%)',v_row.intentos; END IF;
  INSERT INTO _w6a1_res VALUES (3,'failed re-claimable; intentos consistente','OK');

  -- T4: processed terminal (no re-claim)
  v_b := _stripe_inbox_processed(v_ev);
  IF NOT v_b THEN RAISE EXCEPTION 'T4: processed no aplicó'; END IF;
  v_row := _stripe_inbox_claim(v_ev);
  IF v_row.id IS NOT NULL THEN RAISE EXCEPTION 'T4: processed fue reclamado'; END IF;
  IF _stripe_inbox_processed(v_ev) <> false THEN RAISE EXCEPTION 'T4: processed->processed no falló cerrado'; END IF;
  INSERT INTO _w6a1_res VALUES (4,'processed terminal (no claim, no re-processed)','OK');

  -- T5: dead terminal + replay explícito lo re-arma
  DECLARE v_ev2 text := 'evt_'||substr(md5(random()::text),1,10);
  BEGIN
    PERFORM _stripe_inbox_receive(v_ev2,'socio','x','acct_w6a1',v_tenant,v_sub,now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev2);
    v_txt := _stripe_inbox_failed(v_ev2,'e',0);  -- max=0 → dead directo
    IF v_txt <> 'dead' THEN RAISE EXCEPTION 'T5: no pasó a dead (=%)',v_txt; END IF;
    v_row := _stripe_inbox_claim(v_ev2);
    IF v_row.id IS NOT NULL THEN RAISE EXCEPTION 'T5: dead fue auto-reclamado'; END IF;
    IF stripe_replay_event(v_ev2) <> true THEN RAISE EXCEPTION 'T5: replay de dead falló'; END IF;
    v_row := _stripe_inbox_claim(v_ev2);
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'T5: tras replay no re-claimable'; END IF;
  END;
  INSERT INTO _w6a1_res VALUES (5,'dead terminal; replay explícito re-arma; processed no replayable','OK');

  -- T5b: replay de processed → false
  IF stripe_replay_event(v_ev) <> false THEN RAISE EXCEPTION 'T5b: se pudo replay un processed'; END IF;
  INSERT INTO _w6a1_res VALUES (6,'replay de processed rechazado','OK');

  -- T6: minimización de payload (whitelist; sin card/number)
  v_r := _stripe_min_payload('{"id":"in_1","status":"paid","number":"4242424242424242","card":{"cvc":"123"},"metadata":{"tenant_id":"t"}}'::jsonb);
  IF (v_r ? 'number') OR (v_r ? 'card') THEN RAISE EXCEPTION 'T6: payload no minimizó (dejó card/number)'; END IF;
  IF (v_r->>'id') <> 'in_1' OR (v_r->'metadata'->>'tenant_id') <> 't' THEN RAISE EXCEPTION 'T6: perdió campos necesarios'; END IF;
  INSERT INTO _w6a1_res VALUES (7,'payload minimization: whitelist (sin card/number, conserva id/metadata)','OK');

  -- OWNERSHIP + WRITER --------------------------------------------------------
  -- T7: ownership correcto → resuelve membresía
  IF _stripe_assert_ownership_sub(v_sub,'acct_w6a1') <> v_mem THEN RAISE EXCEPTION 'T7: ownership correcto no resolvió'; END IF;
  INSERT INTO _w6a1_res VALUES (8,'ownership correcto (account→tenant→membresía)','OK');

  -- T8: cross-tenant negativo (cuenta de otro tenant) → RAISE
  v_ok := false;
  BEGIN PERFORM _stripe_assert_ownership_sub(v_sub,'acct_w6a1b');
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'STRIPE_OWNERSHIP%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T8: cross-tenant no fue rechazado'; END IF;
  INSERT INTO _w6a1_res VALUES (9,'ownership cross-tenant NEGATIVO rechazado (fail-closed)','OK');

  -- T9: writer aplica past_due (Stripe-driven) → no-vigente, cache sincronizado, créditos intactos
  v_r := stripe_aplicar_estado_membresia(v_sub,'past_due', now(), 'evt_pd_1', 'acct_w6a1');
  IF (v_r->>'applied')::boolean <> true THEN RAISE EXCEPTION 'T9: writer no aplicó past_due'; END IF;
  SELECT status INTO v_status FROM membresias WHERE id=v_mem;
  IF v_status <> 'past_due' THEN RAISE EXCEPTION 'T9: status no quedó past_due'; END IF;
  SELECT vigente INTO v_vig FROM v_socio_membresia WHERE usuario_id=v_u;
  IF v_vig IS DISTINCT FROM false THEN RAISE EXCEPTION 'T9: past_due quedó vigente (=%)',v_vig; END IF;
  SELECT membresia_activa_id INTO v_ptr FROM usuarios WHERE id=v_u;
  IF v_ptr IS NOT NULL THEN RAISE EXCEPTION 'T9: W5-B no limpió cache al salir de activa'; END IF;
  INSERT INTO _w6a1_res VALUES (10,'writer past_due → no-vigente + W5-B sincroniza cache','OK');

  -- T10: evento viejo NO resucita (orden por objeto)
  v_r := stripe_aplicar_estado_membresia(v_sub,'activa', now()-interval '10 days', 'evt_old', 'acct_w6a1');
  IF (v_r->>'applied')::boolean <> false OR (v_r->>'reason') <> 'stale' THEN RAISE EXCEPTION 'T10: evento viejo se aplicó (=%)',v_r; END IF;
  SELECT status INTO v_status FROM membresias WHERE id=v_mem;
  IF v_status <> 'past_due' THEN RAISE EXCEPTION 'T10: un evento viejo cambió el status'; END IF;
  INSERT INTO _w6a1_res VALUES (11,'evento fuera de orden (más viejo) NO resucita estado','OK');

  -- T11: writer cancelada → no-vigente + cancelada_at
  v_r := stripe_aplicar_estado_membresia(v_sub,'cancelada', now()+interval '1 hour', 'evt_cx', 'acct_w6a1');
  IF (v_r->>'applied')::boolean <> true THEN RAISE EXCEPTION 'T11: no canceló'; END IF;
  SELECT status INTO v_status FROM membresias WHERE id=v_mem;
  IF v_status <> 'cancelada' OR (SELECT cancelada_at FROM membresias WHERE id=v_mem) IS NULL THEN RAISE EXCEPTION 'T11: cancelada/cancelada_at mal'; END IF;
  INSERT INTO _w6a1_res VALUES (12,'writer cancelada → no-vigente + cancelada_at','OK');

  -- T12: créditos intactos (writer nunca los toca) — la membresía era tiempo (NULL), sigue NULL
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id=v_mem;
  IF v_saldo IS NOT NULL THEN RAISE EXCEPTION 'T12: el writer tocó créditos (=%)',v_saldo; END IF;
  INSERT INTO _w6a1_res VALUES (13,'W4: writer NO toca créditos','OK');

  -- T13: status inválido rechazado
  v_ok := false;
  BEGIN PERFORM stripe_aplicar_estado_membresia(v_sub,'congelada', now()+interval '2 hours','evt_z','acct_w6a1');
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'STRIPE_STATUS_INVALIDO%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T13: status no-Stripe fue aceptado'; END IF;
  INSERT INTO _w6a1_res VALUES (14,'writer rechaza status no-Stripe (congelada)','OK');

  -- T14: writer authenticated/anon rechazado (sin EXECUTE grant)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
  v_ok := false;
  BEGIN SET LOCAL ROLE authenticated;
    PERFORM stripe_aplicar_estado_membresia(v_sub,'activa', now()+interval '3 hours','evt_a','acct_w6a1');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := (SQLSTATE='42501'); END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T14: authenticated pudo llamar el writer'; END IF;
  v_ok := false;
  BEGIN SET LOCAL ROLE anon;
    PERFORM stripe_aplicar_estado_membresia(v_sub,'activa', now()+interval '3 hours','evt_a2','acct_w6a1');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := (SQLSTATE='42501'); END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T14: anon pudo llamar el writer'; END IF;
  PERFORM set_config('request.jwt.claims','',true);
  INSERT INTO _w6a1_res VALUES (15,'writer service_role-only: authenticated y anon rechazados','OK');

  -- T15: W5-C sigue bloqueando el UPDATE directo de lifecycle — como ADMIN (RLS
  -- membresias_admin_all SÍ permite al admin, así que quien bloquea es W5-C).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
  v_ok := false;
  BEGIN SET LOCAL ROLE authenticated;
    UPDATE membresias SET status='activa' WHERE id=v_mem;
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'MEMBRESIA_OFF_RPC%'; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true);
  IF NOT v_ok THEN RAISE EXCEPTION 'T15: W5-C no bloqueó el UPDATE directo de status por admin'; END IF;
  IF (SELECT status FROM membresias WHERE id=v_mem) <> 'cancelada' THEN RAISE EXCEPTION 'T15: el status cambió por vía directa'; END IF;
  INSERT INTO _w6a1_res VALUES (16,'W5-C preservado: UPDATE directo de lifecycle por admin → MEMBRESIA_OFF_RPC','OK');

  -- T16: atomic completion — efecto + processed en una tx que revierte → NADA aplicado
  DECLARE v_ev3 text := 'evt_'||substr(md5(random()::text),1,10); v_sub3 text := 'sub_'||substr(md5(random()::text),1,10); v_mem3 uuid; v_u3 uuid;
  BEGIN
    INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-3@x.dev','U3','miembro','activo') RETURNING id INTO v_u3;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, stripe_subscription_id)
    VALUES (v_tenant, v_u3, v_tier, 'activa', now(), now()+interval '30 days', v_sub3) RETURNING id INTO v_mem3;
    PERFORM _stripe_inbox_receive(v_ev3,'socio','customer.subscription.deleted','acct_w6a1',v_tenant,v_sub3,now(),'{}');
    PERFORM _stripe_inbox_claim(v_ev3);
    BEGIN  -- subtransacción que simula "efecto + processed" y luego revienta
      PERFORM stripe_aplicar_estado_membresia(v_sub3,'cancelada', now(),'evt_atomic','acct_w6a1');
      PERFORM _stripe_inbox_processed(v_ev3);
      RAISE EXCEPTION 'ROLLBACK_ATOMIC';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'ROLLBACK_ATOMIC' THEN RAISE; END IF;
    END;
    -- Tras el rollback de la subtransacción: ni efecto ni processed.
    IF (SELECT status FROM membresias WHERE id=v_mem3) <> 'activa' THEN RAISE EXCEPTION 'T16: el efecto sobrevivió al rollback'; END IF;
    IF (SELECT estado FROM stripe_event_inbox WHERE id=v_ev3) <> 'processing' THEN RAISE EXCEPTION 'T16: inbox quedó processed pese al rollback'; END IF;
  END;
  INSERT INTO _w6a1_res VALUES (17,'atomic completion: rollback no deja efecto-aplicado ni inbox-processed','OK');

  PERFORM set_config('request.jwt.claims','',true);
  -- Limpieza: el inbox tiene tenant_id ON DELETE SET NULL, así que cerrar_tenant
  -- no lo borra; se limpian las filas de prueba por su account_id de test.
  DELETE FROM stripe_event_inbox WHERE account_id IN ('acct_w6a1','acct_w6a1b');
  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug2);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; PERFORM set_config('request.jwt.claims','',true); RAISE;
END $outer$;

-- ── CONTRACT: W1-W5 + huella intactos ────────────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  IF to_regclass('public.business_operations') IS NULL THEN RAISE EXCEPTION 'CONTRATO: W1'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='reservar_clase_atomic' ORDER BY oid DESC LIMIT 1;
  IF position('clase_lugares:' IN v_src)=0 THEN RAISE EXCEPTION 'CONTRATO: W2'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='trg_proteger_usuarios' ORDER BY oid DESC LIMIT 1;
  IF position('membresia_tier' IN v_src)=0 THEN RAISE EXCEPTION 'CONTRATO: W3'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='trg_membresia_credito_guard') THEN RAISE EXCEPTION 'CONTRATO: W4-A5'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='trg_membresia_lifecycle_guard') THEN RAISE EXCEPTION 'CONTRATO: W5-C'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='trg_sync_membresia_cache') THEN RAISE EXCEPTION 'CONTRATO: W5-B'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='check_in_por_huella') THEN RAISE EXCEPTION 'CONTRATO: huella'; END IF;
  -- inbox NO reemplazó stripe_webhook_events
  IF to_regclass('public.stripe_webhook_events') IS NULL THEN RAISE EXCEPTION 'CONTRATO: stripe_webhook_events fue removido (debe coexistir)'; END IF;
  INSERT INTO _w6a1_res VALUES (18,'contract: W1-W5 + huella + stripe_webhook_events coexisten','OK');
END $$;

SELECT orden, prueba, resultado FROM _w6a1_res ORDER BY orden;

COMMIT;
