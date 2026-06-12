-- ============================================================================
-- FIX RLS: recepcionista puede LEER membresias de su tenant
-- ----------------------------------------------------------------------------
-- Bug: membresias_read_admin usaba is_admin(), no is_recepcionista(). Un
-- recepcionista puro (rol='recepcionista', no admin) recibía 0 filas al leer
-- membresias → useSocioFicha mostraba "sin_plan" falso en la ficha de socio.
--
-- Fix (Opción B): alinear membresias con el patrón de sus tablas hermanas
-- (usuarios_read_admin, reservas_read_admin, membresia_mov_read_staff), todas
-- con `tenant_id = get_my_tenant_id() AND is_recepcionista()`. is_recepcionista()
-- ya incluye admin → admin no pierde acceso. La policy de ESCRITURA
-- (membresias_admin_all, is_admin()) NO se toca → recepción sigue sin escribir.
-- ============================================================================

DROP POLICY IF EXISTS membresias_read_admin ON membresias;
CREATE POLICY membresias_read_admin ON membresias
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- (membresias_read_self y membresias_admin_all quedan intactas.)

-- ============================================================================
-- TEST de RLS — aborta la migración si algo falla.
--   Simula callers reales seteando request.jwt.claims (sub) + SET LOCAL ROLE
--   authenticated, para que auth.uid() resuelva y la RLS se aplique de verdad
--   (el owner del editor bypassa RLS → hay que cambiar de rol).
--
--   Aprovecha el trigger on_auth_user_created: al insertar en auth.users, se
--   auto-crea el usuarios como 'miembro' del tenant (resuelto por tenant_slug
--   en raw_user_meta_data) → luego se ajusta el rol.
--
--   Todo dentro de una subtransacción que se revierte con excepción centinela:
--   no queda ninguna fila de prueba (auth.users / usuarios / membresias).
--
--   Cobertura:
--     1. recepcionista PURO  → VE la membresía (JOIN a tiers, como el hook)  (EL FIX)
--     2. admin               → VE la membresía              (no-regresión lectura)
--     3. miembro NO dueño    → NO ve la membresía ajena     (no-regresión socio)
--     4. miembro dueño       → VE su propia membresía       (read_self sano)
--     5. recepcionista       → NO puede INSERT en membresias (no-regresión escritura)
--     6. recepcionista OTRO tenant → NO ve la membresía     (aislamiento multi-tenant)
-- ============================================================================
DO $$
DECLARE
  v_tenant  uuid; v_slug  text; v_tier  uuid;
  v_tenant2 uuid; v_slug2 text; v_tier2 uuid;   -- segundo tenant (cross-tenant)
  v_auth_recep  uuid := gen_random_uuid();
  v_auth_admin  uuid := gen_random_uuid();
  v_auth_socA   uuid := gen_random_uuid();
  v_auth_socB   uuid := gen_random_uuid();
  v_auth_recep2 uuid := gen_random_uuid();
  v_uA uuid; v_uB uuid;
  v_mem uuid;
  v_seen int;
  v_blocked boolean;
BEGIN
  -- Tenant 1: el primero que tenga al menos un tier (membresias.tier_id NOT NULL).
  SELECT t.id, t.slug, ti.id
    INTO v_tenant, v_slug, v_tier
  FROM tenants t
  JOIN tiers ti ON ti.tenant_id = t.id
  LIMIT 1;

  IF v_tenant IS NULL THEN
    RAISE NOTICE 'TEST: no hay tenant con tier — salto el test (la policy ya quedó aplicada).';
    RETURN;
  END IF;

  -- Tenant 2: otro tenant distinto, también con tier (para el test cross-tenant).
  SELECT t.id, t.slug, ti.id
    INTO v_tenant2, v_slug2, v_tier2
  FROM tenants t
  JOIN tiers ti ON ti.tenant_id = t.id
  WHERE t.id <> v_tenant
  LIMIT 1;

  BEGIN  -- ── subtransacción reversible ──────────────────────────────────────
    -- auth.users del tenant 1 → el trigger crea el usuarios 'miembro'.
    INSERT INTO auth.users (instance_id, id, aud, role, email,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES
      ('00000000-0000-0000-0000-000000000000', v_auth_recep, 'authenticated', 'authenticated',
       'rls-audit-recep-'||substr(v_auth_recep::text,1,8)||'@test.local',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', v_slug, 'nombre','Audit Recep'), now(), now()),
      ('00000000-0000-0000-0000-000000000000', v_auth_admin, 'authenticated', 'authenticated',
       'rls-audit-admin-'||substr(v_auth_admin::text,1,8)||'@test.local',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', v_slug, 'nombre','Audit Admin'), now(), now()),
      ('00000000-0000-0000-0000-000000000000', v_auth_socA, 'authenticated', 'authenticated',
       'rls-audit-socA-'||substr(v_auth_socA::text,1,8)||'@test.local',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', v_slug, 'nombre','Audit SocioA'), now(), now()),
      ('00000000-0000-0000-0000-000000000000', v_auth_socB, 'authenticated', 'authenticated',
       'rls-audit-socB-'||substr(v_auth_socB::text,1,8)||'@test.local',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', v_slug, 'nombre','Audit SocioB'), now(), now());

    -- Ajustar roles (el trigger los dejó como 'miembro').
    UPDATE usuarios SET rol='recepcionista', status='activo' WHERE auth_id = v_auth_recep;
    UPDATE usuarios SET rol='admin',         status='activo' WHERE auth_id = v_auth_admin;
    SELECT id INTO v_uA FROM usuarios WHERE auth_id = v_auth_socA;  -- queda 'miembro'
    SELECT id INTO v_uB FROM usuarios WHERE auth_id = v_auth_socB;  -- queda 'miembro'

    -- Membresía activa del Socio A (tenant 1).
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_fin)
    VALUES (v_tenant, v_uA, v_tier, 'activa', now() + interval '30 days')
    RETURNING id INTO v_mem;

    -- 1) recepcionista PURO VE la membresía — imitando la query del hook
    --    (JOIN a tiers: prueba RLS de membresias + RLS de tiers + el JOIN).  (EL FIX)
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_recep::text)::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_seen
    FROM membresias m
    LEFT JOIN tiers t ON t.id = m.tier_id
    WHERE m.id = v_mem AND t.nombre IS NOT NULL;
    RESET ROLE;
    IF v_seen <> 1 THEN
      RAISE EXCEPTION 'TEST FALLÓ (1): recepcionista NO pudo leer la membresía+tier (vio %).', v_seen;
    END IF;

    -- 2) admin VE la membresía  (no-regresión lectura)
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_admin::text)::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_seen FROM membresias WHERE id = v_mem;
    RESET ROLE;
    IF v_seen <> 1 THEN
      RAISE EXCEPTION 'TEST FALLÓ (2): admin dejó de leer la membresía (vio %).', v_seen;
    END IF;

    -- 3) miembro NO dueño NO ve la membresía ajena  (no-regresión socio)
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_socB::text)::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_seen FROM membresias WHERE id = v_mem;
    RESET ROLE;
    IF v_seen <> 0 THEN
      RAISE EXCEPTION 'TEST FALLÓ (3): un miembro ajeno pudo leer la membresía (vio %).', v_seen;
    END IF;

    -- 4) miembro dueño VE su propia membresía  (read_self sano)
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_socA::text)::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_seen FROM membresias WHERE id = v_mem;
    RESET ROLE;
    IF v_seen <> 1 THEN
      RAISE EXCEPTION 'TEST FALLÓ (4): el dueño no pudo leer su propia membresía (vio %).', v_seen;
    END IF;

    -- 5) recepcionista NO puede INSERT en membresias  (no-regresión escritura).
    --    El INSERT replica las columnas de v_mem para que NO falle por
    --    NOT NULL / CHECK (eso sería un falso "TEST FALLÓ" por setup, no por RLS).
    v_blocked := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_recep::text)::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_fin)
      VALUES (v_tenant, v_uB, v_tier, 'activa', now() + interval '30 days');
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;  -- bloqueado por RLS = lo esperado
      WHEN check_violation THEN
        RESET ROLE;
        RAISE EXCEPTION 'TEST 5 SETUP: el INSERT falló por check_violation, no por RLS. Revisá las columnas del INSERT del test (no es un bug real).';
      WHEN not_null_violation THEN
        RESET ROLE;
        RAISE EXCEPTION 'TEST 5 SETUP: el INSERT falló por NOT NULL, no por RLS. Sumá las columnas requeridas al INSERT del test (no es un bug real).';
    END;
    RESET ROLE;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'TEST FALLÓ (5): un recepcionista pudo INSERT en membresias.';
    END IF;

    -- 6) recepcionista de OTRO tenant NO ve la membresía del tenant 1
    --    (aislamiento multi-tenant). Se auto-excluye si no hay 2º tenant con tier.
    IF v_tenant2 IS NULL THEN
      RAISE NOTICE 'WARN: solo 1 tenant con tier en la DB — test #6 cross-tenant NO corrió.';
    ELSE
      INSERT INTO auth.users (instance_id, id, aud, role, email,
                              raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES
        ('00000000-0000-0000-0000-000000000000', v_auth_recep2, 'authenticated', 'authenticated',
         'rls-audit-recep2-'||substr(v_auth_recep2::text,1,8)||'@test.local',
         '{"provider":"email","providers":["email"]}'::jsonb,
         jsonb_build_object('tenant_slug', v_slug2, 'nombre','Audit Recep T2'), now(), now());
      UPDATE usuarios SET rol='recepcionista', status='activo' WHERE auth_id = v_auth_recep2;

      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_recep2::text)::text, true);
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v_seen FROM membresias WHERE id = v_mem;
      RESET ROLE;
      IF v_seen <> 0 THEN
        RAISE EXCEPTION 'AGUJERO MULTI-TENANT en membresias (6): un recepcionista de otro tenant vio la membresía (vio %).', v_seen;
      END IF;
    END IF;

    -- Revertir todas las filas de prueba.
    RAISE EXCEPTION 'ROLLBACK_TEST_DATA';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_TEST_DATA' THEN
      NULL;  -- ok: subtransacción revertida, sin filas de prueba
    ELSE
      RAISE; -- un 'TEST FALLÓ …' / 'SETUP' / 'AGUJERO …' real → aborta la migración
    END IF;
  END;

  IF v_tenant2 IS NULL THEN
    RAISE NOTICE 'TEST OK ✔ (1) recep lee · (2) admin lee · (3) ajeno NO · (4) dueño sí · (5) recep NO escribe · (6) SALTADO (1 solo tenant) · filas revertidas.';
  ELSE
    RAISE NOTICE 'TEST OK ✔ (1) recep lee · (2) admin lee · (3) ajeno NO · (4) dueño sí · (5) recep NO escribe · (6) cross-tenant aislado · filas revertidas.';
  END IF;
END $$;
