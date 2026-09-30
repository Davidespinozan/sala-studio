-- ============================================================================
-- WAVE 4 · A5 (última pieza) — Bloquear el UPDATE directo de creditos_restantes
-- ----------------------------------------------------------------------------
-- D3 (owner): todo cambio de creditos_restantes debe pasar por una operación
-- canónica (RPC SECURITY DEFINER que deja asiento). El UPDATE directo por
-- PostgREST/admin queda PROHIBIDO.
--
-- Mecanismo APROBADO = current_user (Opción Y, idéntico al patrón ya en prod de
-- W3 trg_proteger_usuarios): un BEFORE UPDATE trigger, SECURITY INVOKER, que
-- RAISE si el saldo cambia mientras current_user es authenticated/anon. Dentro de
-- una función SECURITY DEFINER (owner) current_user = el dueño → pasa; un PATCH
-- directo por PostgREST corre como authenticated → se bloquea.
--
-- Por qué NO hace falta reescribir los RPC vivos (reserva/cancelación/Stripe/
-- gestionar/waitlist/import/expiración): todos son SECURITY DEFINER → sus
-- escrituras inline de creditos_restantes corren como owner → pasan intactas.
-- Verificado read-only: NINGÚN código de front/edge escribe creditos_restantes
-- directo (todo va por RPC).
--
-- NO toca: RPC de crédito/reserva/huella, W1/W2/W3, las 31 divergencias, datos
-- reales. Aditiva; BEGIN/COMMIT con self-tests que DEVUELVEN TABLA + contract.
-- ============================================================================

BEGIN;

-- ── Guard: el saldo solo cambia desde una operación canónica (owner) ─────────
-- SECURITY INVOKER (default): DEBE ver el current_user real. Si fuera DEFINER,
-- current_user sería siempre el dueño y el guard nunca dispararía.
CREATE OR REPLACE FUNCTION trg_membresia_credito_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.creditos_restantes IS DISTINCT FROM OLD.creditos_restantes
     AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'CREDITO_OFF_LEDGER: el saldo de créditos solo cambia por una operación canónica (recarga/ajuste/reserva/cancelación/…), no por edición directa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS membresia_credito_guard ON membresias;
CREATE TRIGGER membresia_credito_guard
  BEFORE UPDATE ON membresias
  FOR EACH ROW
  EXECUTE FUNCTION trg_membresia_credito_guard();

COMMENT ON FUNCTION trg_membresia_credito_guard() IS
  'W4·A5. Bloquea el cambio directo de membresias.creditos_restantes cuando '
  'current_user es authenticated/anon (PATCH por PostgREST). Los RPC SECURITY '
  'DEFINER corren como owner y pasan. Todo cambio de saldo deja asiento vía RPC.';


-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenant desechable; cerrar_tenant limpia.
-- Función DEFINER de prueba (_zz_w4a5_def) para el caso "authenticated → RPC".
-- ============================================================================

-- Función DEFINER throwaway: simula la escritura INLINE de un RPC vivo
-- (reservar_clase_atomic hace exactamente esto: UPDATE ... creditos_restantes).
CREATE OR REPLACE FUNCTION _zz_w4a5_def(p_mem uuid, p_delta integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE membresias SET creditos_restantes = COALESCE(creditos_restantes,0) + p_delta WHERE id = p_mem;
END; $$;

CREATE TEMP TABLE _w4a5_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug text := 'zz-w4a5-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid;
  v_auth_admin uuid := gen_random_uuid();
  v_admin uuid;
  v_socio uuid;
  v_tier uuid;
  v_mem uuid;
  v_saldo integer;
  v_status text;
  v_ok boolean;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'W4A5', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  -- Admin con auth (para is_admin() + RLS membresias_admin_all). El trigger
  -- handle_new_auth_user crea la ficha; solo la promovemos a admin.
  INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000',v_auth_admin,'authenticated','authenticated',
          v_slug||'-a@test.local','{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('tenant_slug',v_slug,'nombre','Admin W4A5'),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth_admin RETURNING id INTO v_admin;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SETUP FALLO: no se creó la ficha admin'; END IF;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug||'-s@test.local', 'Socio', 'miembro', 'activo') RETURNING id INTO v_socio;

  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas)
  VALUES (v_tenant, 'w4a5-cred', 'W4A5 Créditos', 100000, 'creditos', 10) RETURNING id INTO v_tier;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, creditos_restantes)
  VALUES (v_tenant, v_socio, v_tier, 'activa', 5) RETURNING id INTO v_mem;

  -- T1: escritura en contexto OWNER (= lo que hace un RPC SECURITY DEFINER inline)
  -- pasa el guard. (En la migración current_user = postgres.)
  UPDATE membresias SET creditos_restantes = creditos_restantes + 1 WHERE id = v_mem;
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  IF v_saldo <> 6 THEN RAISE EXCEPTION 'T1 FALLO: escritura owner inline no pasó (=%)', v_saldo; END IF;
  INSERT INTO _w4a5_res VALUES (1, 'escritura inline en contexto owner (RPC DEFINER) pasa (5→6)', 'OK');

  -- T2: helper canónico pasa.
  PERFORM _aplicar_credito(v_mem, -1, 'debito', 'test a5', NULL, NULL, NULL);
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  IF v_saldo <> 5 THEN RAISE EXCEPTION 'T2 FALLO: _aplicar_credito no pasó (=%)', v_saldo; END IF;
  INSERT INTO _w4a5_res VALUES (2, '_aplicar_credito (canónico) pasa (6→5)', 'OK');

  -- Actuar como el admin autenticado (PostgREST): jwt + role.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_admin)::text, true);

  -- T3: admin autenticado llamando un RPC DEFINER (inline) → PASA (current_user
  -- pasa a ser el owner dentro de la función).
  v_ok := true;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM _zz_w4a5_def(v_mem, 2);
  EXCEPTION WHEN OTHERS THEN v_ok := false;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T3 FALLO: un RPC DEFINER llamado por authenticated fue bloqueado'; END IF;
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  IF v_saldo <> 7 THEN RAISE EXCEPTION 'T3 FALLO: el RPC DEFINER no aplicó el cambio (=%)', v_saldo; END IF;
  INSERT INTO _w4a5_res VALUES (3, 'authenticated → RPC SECURITY DEFINER (inline) pasa (5→7)', 'OK');

  -- T4: admin autenticado con UPDATE DIRECTO de creditos_restantes → BLOQUEADO.
  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE membresias SET creditos_restantes = 999 WHERE id = v_mem;
  EXCEPTION WHEN raise_exception THEN
    v_ok := SQLERRM LIKE 'CREDITO_OFF_LEDGER%';
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T4 FALLO: un UPDATE directo de creditos_restantes por admin NO fue bloqueado'; END IF;
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  IF v_saldo <> 7 THEN RAISE EXCEPTION 'T4 FALLO: el saldo cambió pese al bloqueo (=%)', v_saldo; END IF;
  INSERT INTO _w4a5_res VALUES (4, 'UPDATE directo de creditos_restantes por admin BLOQUEADO (CREDITO_OFF_LEDGER)', 'OK');

  -- T5: admin autenticado con UPDATE directo de OTRA columna (status) → permitido
  -- (el guard solo protege el saldo, no sobre-bloquea la edición de membresías).
  v_ok := true;
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE membresias SET status = 'congelada' WHERE id = v_mem;
  EXCEPTION WHEN OTHERS THEN v_ok := false;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T5 FALLO: se bloqueó una edición legítima de otra columna (status)'; END IF;
  SELECT status INTO v_status FROM membresias WHERE id = v_mem;
  IF v_status <> 'congelada' THEN RAISE EXCEPTION 'T5 FALLO: el status no cambió (=%)', v_status; END IF;
  INSERT INTO _w4a5_res VALUES (5, 'edición directa de otra columna (status) sigue permitida', 'OK');

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM cerrar_tenant(v_slug);

EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END $outer$;

-- Limpiar la función throwaway (en éxito). En fallo, el BEGIN/COMMIT revierte todo.
DROP FUNCTION IF EXISTS _zz_w4a5_def(uuid, integer);

-- ── CONTRACT: W1/W2/W3 + huella intactos (A5 no los toca) ────────────────────
DO $$
DECLARE v_src text;
BEGIN
  IF to_regclass('public.business_operations') IS NULL THEN
    RAISE EXCEPTION 'CONTRATO FALLO: business_operations (W1) no existe'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='reservar_clase_atomic' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('clase_lugares:' IN v_src)=0 THEN
    RAISE EXCEPTION 'CONTRATO FALLO: reservar_clase_atomic perdió el advisory lock (W2)'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='trg_proteger_usuarios' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('membresia_tier' IN v_src)=0 THEN
    RAISE EXCEPTION 'CONTRATO FALLO: trg_proteger_usuarios perdió membresia_tier (W3)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='check_in_por_huella') THEN
    RAISE EXCEPTION 'CONTRATO FALLO: check_in_por_huella desapareció'; END IF;
  INSERT INTO _w4a5_res VALUES (6, 'contract: W1/W2/W3 + huella intactos', 'OK');
END $$;

SELECT orden, prueba, resultado FROM _w4a5_res ORDER BY orden;

COMMIT;
