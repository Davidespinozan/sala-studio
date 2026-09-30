-- ============================================================================
-- WAVE 5 · C — Authority closure: bloquear escritura directa de lifecycle
-- ----------------------------------------------------------------------------
-- D-W5-3: todo cambio de ciclo de vida de la membresía debe pasar por un RPC/
-- comando canónico; el PATCH/INSERT/DELETE directo por authenticated/admin queda
-- prohibido. Mecanismo current_user (igual que W4-A5 / W3): un trigger SECURITY
-- INVOKER que RAISE si current_user es authenticated/anon y se toca el lifecycle.
--
-- Verificado read-only (pre-apply): NINGÚN código de front/edge escribe membresias
-- directo (todo por RPC SECURITY DEFINER o backend service_role). Por eso esto no
-- rompe ninguna ruta legítima:
--   · RPCs (asignar/renovar/cambiar/congelar/reactivar/cancelar, gestionar,
--     activar_suscripcion, importar) son SECURITY DEFINER → current_user=owner → pasan.
--   · Backend Stripe/cron via service_role → current_user='service_role' → pasan
--     (su canonicalización profunda es W6; el cache lo sincroniza W5-B).
--   · admin/miembro via PostgREST → current_user='authenticated' → BLOQUEADO.
--
-- Columnas de lifecycle protegidas: status, tier_id, periodo_actual_inicio/fin,
-- congelada_at, cancelada_at, cancelada_efectiva_at, commitment_ends_at,
-- trial_starts_at, trial_ends_at, stripe_subscription_id, stripe_customer_id.
-- NO incluye creditos_restantes (ya lo protege W4-A5) ni columnas no-lifecycle
-- (sucursal_id/metodo_pago/aviso_vencimiento_at) para no sobre-bloquear.
-- Aditiva; BEGIN/COMMIT + self-tests. ES LA ÚLTIMA PIEZA DE BLINDAJE (tras B/F/ext).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION trg_membresia_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN COALESCE(NEW, OLD);  -- RPC (owner) / service_role / migración: permitido
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'MEMBRESIA_OFF_RPC: una membresía solo se crea por una operación canónica (asignar plan / activación), no por inserción directa';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MEMBRESIA_OFF_RPC: una membresía no se borra directo (baja = cancelar; cierre de negocio = cerrar_tenant)';
  ELSIF TG_OP = 'UPDATE' AND (
        NEW.status                 IS DISTINCT FROM OLD.status
     OR NEW.tier_id                IS DISTINCT FROM OLD.tier_id
     OR NEW.periodo_actual_inicio  IS DISTINCT FROM OLD.periodo_actual_inicio
     OR NEW.periodo_actual_fin     IS DISTINCT FROM OLD.periodo_actual_fin
     OR NEW.congelada_at           IS DISTINCT FROM OLD.congelada_at
     OR NEW.cancelada_at           IS DISTINCT FROM OLD.cancelada_at
     OR NEW.cancelada_efectiva_at  IS DISTINCT FROM OLD.cancelada_efectiva_at
     OR NEW.commitment_ends_at     IS DISTINCT FROM OLD.commitment_ends_at
     OR NEW.trial_starts_at        IS DISTINCT FROM OLD.trial_starts_at
     OR NEW.trial_ends_at          IS DISTINCT FROM OLD.trial_ends_at
     OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
     OR NEW.stripe_customer_id     IS DISTINCT FROM OLD.stripe_customer_id
  ) THEN
    RAISE EXCEPTION 'MEMBRESIA_OFF_RPC: el ciclo de vida de la membresía solo cambia por una operación canónica (asignar/renovar/cambiar/congelar/reactivar/cancelar), no por edición directa';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_membresia_lifecycle_guard() IS
  'W5-C. Bloquea INSERT/DELETE y cambios de columnas de lifecycle en membresias '
  'cuando current_user es authenticated/anon (PATCH por PostgREST). RPC DEFINER '
  '(owner) y service_role pasan. No cubre creditos_restantes (W4-A5).';

DROP TRIGGER IF EXISTS membresia_lifecycle_guard ON membresias;
CREATE TRIGGER membresia_lifecycle_guard
  BEFORE INSERT OR UPDATE OR DELETE ON membresias
  FOR EACH ROW
  EXECUTE FUNCTION trg_membresia_lifecycle_guard();


-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — admin con auth+jwt; tenant desechable.
-- ============================================================================
CREATE TEMP TABLE _w5c_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug text := 'zz-w5c-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_admin uuid;
  v_socio uuid; v_tier uuid; v_mem uuid;
  v_ok boolean; v_status text;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'W5C','gym_libre','activo') RETURNING id INTO v_tenant;
  INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000',v_auth,'authenticated','authenticated',v_slug||'-a@test.local',
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth RETURNING id INTO v_admin;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SETUP: no se creó la ficha admin'; END IF;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-s@test.local','Socio','miembro','activo') RETURNING id INTO v_socio;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, duracion_dias) VALUES (v_tenant,'w5c-t','T',100000,'tiempo',30) RETURNING id INTO v_tier;
  -- INSERT de membresía en contexto owner (migración) → permitido.
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now()+interval '30 days') RETURNING id INTO v_mem;
  INSERT INTO _w5c_res VALUES (1, 'INSERT de membresía en contexto owner permitido', 'OK');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- T2: admin autenticado, UPDATE directo de status → BLOQUEADO.
  v_ok := false;
  BEGIN SET LOCAL ROLE authenticated;
    UPDATE membresias SET status='cancelada' WHERE id=v_mem;
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'MEMBRESIA_OFF_RPC%'; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T2: UPDATE directo de status NO fue bloqueado'; END IF;
  INSERT INTO _w5c_res VALUES (2, 'UPDATE directo de status por admin BLOQUEADO', 'OK');

  -- T3: admin autenticado, UPDATE directo de tier_id → BLOQUEADO.
  v_ok := false;
  BEGIN SET LOCAL ROLE authenticated;
    UPDATE membresias SET tier_id=v_tier, periodo_actual_fin=now()+interval '999 days' WHERE id=v_mem;
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'MEMBRESIA_OFF_RPC%'; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T3: UPDATE directo de tier/periodo NO fue bloqueado'; END IF;
  INSERT INTO _w5c_res VALUES (3, 'UPDATE directo de tier_id/periodo por admin BLOQUEADO', 'OK');

  -- T4: admin autenticado, INSERT directo de membresía → BLOQUEADO.
  v_ok := false;
  BEGIN SET LOCAL ROLE authenticated;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
    VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now()+interval '30 days');
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'MEMBRESIA_OFF_RPC%'; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T4: INSERT directo de membresía NO fue bloqueado'; END IF;
  INSERT INTO _w5c_res VALUES (4, 'INSERT directo de membresía por admin BLOQUEADO', 'OK');

  -- T5: RPC canónico (DEFINER) llamado por el admin autenticado → PASA.
  v_ok := true;
  BEGIN SET LOCAL ROLE authenticated;
    PERFORM recepcion_congelar_membresia(v_socio, 'pausa via rpc');
  EXCEPTION WHEN OTHERS THEN v_ok := false; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T5: un RPC canónico (DEFINER) fue bloqueado'; END IF;
  SELECT status INTO v_status FROM membresias WHERE id=v_mem;
  IF v_status <> 'congelada' THEN RAISE EXCEPTION 'T5: el RPC no aplicó (status=%)', v_status; END IF;
  INSERT INTO _w5c_res VALUES (5, 'RPC canónico DEFINER (congelar) SÍ pasa para admin autenticado', 'OK');

  -- T6: admin autenticado, UPDATE de columna NO-lifecycle (metodo_pago) → permitido.
  v_ok := true;
  BEGIN SET LOCAL ROLE authenticated;
    UPDATE membresias SET metodo_pago='efectivo' WHERE id=v_mem;
  EXCEPTION WHEN OTHERS THEN v_ok := false; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T6: se bloqueó un UPDATE de columna no-lifecycle (metodo_pago)'; END IF;
  INSERT INTO _w5c_res VALUES (6, 'UPDATE de columna no-lifecycle (metodo_pago) NO se sobre-bloquea', 'OK');

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM cerrar_tenant(v_slug);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END $outer$;

-- ── CONTRACT: W1/W2/W3/W4 + W5 previos + huella intactos ─────────────────────
DO $$
DECLARE v_src text;
BEGIN
  IF to_regclass('public.business_operations') IS NULL THEN RAISE EXCEPTION 'CONTRATO: W1'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='trg_membresia_credito_guard' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('CREDITO_OFF_LEDGER' IN v_src)=0 THEN RAISE EXCEPTION 'CONTRATO: W4-A5 saldo guard'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='trg_sync_membresia_cache') THEN RAISE EXCEPTION 'CONTRATO: W5-B sync'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='es_membresia_vigente') THEN RAISE EXCEPTION 'CONTRATO: W5-A predicado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='check_in_por_huella') THEN RAISE EXCEPTION 'CONTRATO: huella'; END IF;
  INSERT INTO _w5c_res VALUES (7, 'contract: W1/W4-A5 + W5-A/B + huella intactos', 'OK');
END $$;

SELECT orden, prueba, resultado FROM _w5c_res ORDER BY orden;

COMMIT;
