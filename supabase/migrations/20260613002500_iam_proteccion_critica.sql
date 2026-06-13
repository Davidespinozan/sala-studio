-- ============================================================================
-- IAM — 3 agujeros críticos de seguridad (bug-hunt equipo/IAM)
-- ============================================================================
-- C1 · Escalada de privilegios: la policy usuarios_update_self solo valida la
--      FILA (auth_id = auth.uid()), no las COLUMNAS. Un miembro/recepcionista
--      logueado podía `update usuarios set rol='admin' where auth_id=mío` por
--      supabase-js y volverse admin de su gym. (RLS no puede comparar OLD/NEW,
--      por eso se resuelve con un trigger.)
--
-- C2 · Permisos persistentes tras revocar: is_admin()/is_recepcionista()
--      chequeaban solo `rol`, nunca `status`. Un admin/recepción revocado o
--      suspendido conservaba TODOS los permisos a nivel DB (RLS + RPCs); el
--      gate de status estaba solo en la UI. Acá exigimos status='activo'.
--
-- C3 · Lockout del tenant: nada impedía dejar el tenant sin ningún admin
--      activo. CambiarEstadoControl (MiembroDetalle) escribía status directo
--      por RLS sin guard, y el guard de "último admin" del revoke era solo
--      client-side. Acá un trigger lo bloquea para TODOS los actores.
--
-- Mecánica del trigger (SECURITY INVOKER a propósito):
--   - current_user refleja el rol EJECUTOR real solo si la función es INVOKER.
--     'authenticated'/'anon'  → acceso directo de un end-user  (se valida C1).
--     'service_role'          → Netlify functions (admin-*)    (confiable).
--     'postgres'/owner        → RPCs SECURITY DEFINER + triggers de sistema
--                               (crear_tenant_onboarding, signup)  (confiable).
--   - is_admin()/count_admins_activos() son SECURITY DEFINER → funcionan aunque
--     el trigger sea INVOKER y el ejecutor sea authenticated.
-- ============================================================================

-- ── C2: is_admin / is_recepcionista exigen status='activo' ──────────────────
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid()
      AND rol = 'admin'
      AND status = 'activo'
  );
$$;

CREATE OR REPLACE FUNCTION is_recepcionista()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid()
      AND rol IN ('recepcionista', 'admin')
      AND status = 'activo'
  );
$$;

COMMENT ON FUNCTION is_admin() IS
  'TRUE si el usuario del JWT es admin ACTIVO del tenant. status!=activo (revocado/suspendido/cancelado) → FALSE (fix IAM C2).';
COMMENT ON FUNCTION is_recepcionista() IS
  'TRUE si el usuario del JWT es recepción o admin ACTIVO. status!=activo → FALSE (fix IAM C2).';

-- ── C1 + C3: trigger BEFORE UPDATE en usuarios ──────────────────────────────
CREATE OR REPLACE FUNCTION trg_proteger_usuarios()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY INVOKER (default): necesitamos el current_user REAL del ejecutor.
AS $$
DECLARE
  v_priv_change boolean;
BEGIN
  v_priv_change :=
       NEW.rol       IS DISTINCT FROM OLD.rol
    OR NEW.status    IS DISTINCT FROM OLD.status
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id;

  -- Updates de perfil (nombre/teléfono/avatar/membresía/etc.): nada que proteger.
  IF NOT v_priv_change THEN
    RETURN NEW;
  END IF;

  -- C1 — un end-user autenticado que NO es admin activo no puede tocar
  -- rol/status/tenant_id (ni en su propia fila). Los flujos legítimos
  -- (service_role de las Netlify functions, RPCs SECURITY DEFINER de owner
  -- postgres) corren con otro current_user y se saltan este check.
  IF current_user IN ('authenticated', 'anon') AND NOT is_admin() THEN
    RAISE EXCEPTION
      'PRIVILEGIO_DENEGADO: no podés modificar rol, estado ni tenant de un usuario.';
  END IF;

  -- C3 — backstop absoluto: nunca dejar el tenant sin ningún admin activo.
  -- Aplica a TODOS los actores (incluido service_role). En un BEFORE trigger la
  -- fila aún tiene OLD, así que count_admins_activos incluye a este admin.
  IF OLD.rol = 'admin' AND OLD.status = 'activo'
     AND (NEW.rol IS DISTINCT FROM 'admin' OR NEW.status IS DISTINCT FROM 'activo') THEN
    IF count_admins_activos(OLD.tenant_id) <= 1 THEN
      RAISE EXCEPTION
        'ULTIMO_ADMIN: no podés dejar el tenant sin ningún admin activo. Asigná otro admin primero.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_proteger_usuarios() IS
  'BEFORE UPDATE usuarios: C1 bloquea cambios de rol/status/tenant por end-users no-admin; C3 impide dejar el tenant sin admin activo.';

DROP TRIGGER IF EXISTS usuarios_proteger_iam ON usuarios;
CREATE TRIGGER usuarios_proteger_iam
  BEFORE UPDATE ON usuarios
  FOR EACH ROW
  EXECUTE FUNCTION trg_proteger_usuarios();

-- ============================================================================
-- TESTS (subtransacciones reversibles; sentinela de rollback al final).
-- ============================================================================
DO $outer$
DECLARE
  v_tenant uuid;
  v_slug text := 'zz-iam-test-'||substr(gen_random_uuid()::text, 1, 8);
  v_auth_admin   uuid := gen_random_uuid();
  v_auth_admin2  uuid := gen_random_uuid();
  v_auth_miembro uuid := gen_random_uuid();
  v_id_admin   uuid;
  v_id_admin2  uuid;
  v_id_miembro uuid;
  v_is_admin boolean;
  v_ok boolean;
BEGIN
  BEGIN  -- ░░ subtransacción reversible ░░
    -- Tenant FRESCO y aislado → count_admins_activos cuenta SOLO los de este test
    -- (un tenant existente podría traer admins preexistentes y romper C3).
    INSERT INTO tenants (slug, nombre, status)
    VALUES (v_slug, 'IAM Test', 'activo')
    RETURNING id INTO v_tenant;

    -- Setup: 2 admins activos + 1 miembro, vía el flujo real (trigger de signup).
    INSERT INTO auth.users (instance_id, id, aud, role, email,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES
      ('00000000-0000-0000-0000-000000000000', v_auth_admin, 'authenticated', 'authenticated',
       'iam-adm-'||substr(v_auth_admin::text,1,8)||'@test.local',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin Uno'), now(), now()),
      ('00000000-0000-0000-0000-000000000000', v_auth_admin2, 'authenticated', 'authenticated',
       'iam-adm2-'||substr(v_auth_admin2::text,1,8)||'@test.local',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin Dos'), now(), now()),
      ('00000000-0000-0000-0000-000000000000', v_auth_miembro, 'authenticated', 'authenticated',
       'iam-mem-'||substr(v_auth_miembro::text,1,8)||'@test.local',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Miembro'), now(), now());

    UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id = v_auth_admin  RETURNING id INTO v_id_admin;
    UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id = v_auth_admin2 RETURNING id INTO v_id_admin2;
    UPDATE usuarios SET status='activo'              WHERE auth_id = v_auth_miembro RETURNING id INTO v_id_miembro;

    -- ── TEST C2: is_admin()=FALSE para un admin revocado ──
    -- (hay 2 admins → revocar a uno es válido para C3)
    UPDATE usuarios SET status='revocado' WHERE id = v_id_admin2;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_admin2)::text, true);
    SELECT is_admin() INTO v_is_admin;
    IF v_is_admin THEN
      RAISE EXCEPTION 'TEST C2 FALLO: is_admin()=true para un admin con status=revocado.';
    END IF;
    PERFORM set_config('request.jwt.claims', '', true);

    -- ── TEST C3a: no se puede revocar al ÚLTIMO admin activo ──
    -- (ahora solo v_id_admin está activo)
    v_ok := false;
    BEGIN
      UPDATE usuarios SET status='revocado' WHERE id = v_id_admin;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'ULTIMO_ADMIN%' THEN v_ok := true; ELSE RAISE; END IF;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'TEST C3a FALLO: se permitió revocar al último admin activo.';
    END IF;

    -- ── TEST C3b: tampoco se puede demotar al último admin activo ──
    v_ok := false;
    BEGIN
      UPDATE usuarios SET rol='miembro' WHERE id = v_id_admin;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'ULTIMO_ADMIN%' THEN v_ok := true; ELSE RAISE; END IF;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'TEST C3b FALLO: se permitió demotar al último admin activo.';
    END IF;

    -- ── TEST C1: un miembro AUTENTICADO no puede auto-promoverse a admin ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_miembro)::text, true);
    v_ok := false;
    BEGIN
      SET LOCAL ROLE authenticated;          -- current_user pasa a 'authenticated'
      UPDATE usuarios SET rol='admin' WHERE id = v_id_miembro;
    EXCEPTION
      WHEN raise_exception THEN
        IF SQLERRM LIKE 'PRIVILEGIO_DENEGADO%' THEN v_ok := true; ELSE RAISE; END IF;
    END;
    RESET ROLE;                              -- por si la subtx no lo revirtió
    PERFORM set_config('request.jwt.claims', '', true);
    IF NOT v_ok THEN
      RAISE EXCEPTION 'TEST C1 FALLO: un miembro autenticado se pudo auto-promover a admin.';
    END IF;

    -- ── TEST positivo: un admin activo SÍ puede cambiar el rol de un miembro ──
    -- (como postgres/owner: current_user no es authenticated → C1 no aplica;
    --  C3 tampoco, el target no es admin) — no debe lanzar.
    UPDATE usuarios SET rol='recepcionista' WHERE id = v_id_miembro;

    RAISE EXCEPTION 'ROLLBACK_SENTINEL_IAM';  -- revierte todo el setup
  EXCEPTION
    WHEN raise_exception THEN
      RESET ROLE;
      IF SQLERRM = 'ROLLBACK_SENTINEL_IAM' THEN
        RAISE NOTICE 'TESTS IAM OK: C1 (auto-promo bloqueada), C2 (revocado sin permisos), C3 (último admin protegido). Revertido.';
      ELSE
        RAISE;  -- propaga cualquier fallo real de test
      END IF;
  END;
END;
$outer$;
