-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- MULTI-GYM · FASE 2 — resolver la ficha del gym ACTIVO por header (retrocompatible)
-- ----------------------------------------------------------------------------
-- Objetivo: una persona podrá tener ficha en varios gyms (Fase 3). Para que el sistema
-- sepa en cuál está, el cliente manda `x-tenant-id` (Fase 1). Aquí las 4 funciones que
-- sostienen TODO el aislamiento (get_my_tenant_id, get_my_user_id, is_admin,
-- is_recepcionista) resuelven la ficha del gym del header — PERO con dos candados:
--
--   1) Solo usa el header si el usuario ES MIEMBRO de ese gym. Si el header apunta a
--      un gym ajeno (o viene basura), CAE AL FALLBACK: su ficha actual (LIMIT 1).
--      → Aunque alguien forje el header, nunca ve un gym que no es suyo.
--   2) Sin header → fallback = comportamiento ACTUAL, idéntico a hoy.
--
-- Como hoy cada persona tiene UNA sola ficha, el resultado es EXACTAMENTE el de hoy
-- para todos (numa incluida), con o sin header. La lógica de roles/status NO cambia.
-- ============================================================================

-- Helper: la ficha (usuarios.id) del gym ACTIVO para esta sesión.
CREATE OR REPLACE FUNCTION _usuario_activo_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hdr text;
  v_id  uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;  -- anónimo → sin ficha (igual que hoy)
  END IF;

  -- 1) header x-tenant-id válido + el usuario es MIEMBRO de ese gym → esa ficha.
  BEGIN
    v_hdr := NULLIF(current_setting('request.headers', true)::json ->> 'x-tenant-id', '');
    IF v_hdr IS NOT NULL THEN
      SELECT id INTO v_id FROM usuarios
      WHERE auth_id = auth.uid() AND tenant_id = v_hdr::uuid
      LIMIT 1;
      IF v_id IS NOT NULL THEN
        RETURN v_id;
      END IF;
    END IF;
  EXCEPTION WHEN others THEN
    NULL;  -- header ausente / no-uuid / JSON raro → cae al fallback
  END;

  -- 2) Fallback = comportamiento actual (su ficha; hoy única por auth_id).
  SELECT id INTO v_id FROM usuarios WHERE auth_id = auth.uid() LIMIT 1;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION _usuario_activo_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _usuario_activo_id() TO anon, authenticated;


-- Las 4 funciones ahora resuelven por la ficha ACTIVA (mismo comportamiento hoy).
CREATE OR REPLACE FUNCTION get_my_user_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT _usuario_activo_id();
$$;

CREATE OR REPLACE FUNCTION get_my_tenant_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT tenant_id FROM usuarios WHERE id = _usuario_activo_id();
$$;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE id = _usuario_activo_id()
      AND rol = 'admin'
      AND status = 'activo'
  );
$$;

CREATE OR REPLACE FUNCTION is_recepcionista()
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE id = _usuario_activo_id()
      AND rol IN ('recepcionista', 'admin')
      AND status = 'activo'
  );
$$;


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA. Simula auth.uid() + el header (request.jwt.claims +
-- request.headers). El transporte real del header ya se verificó en Fase 0.
--   Usuario A: ficha admin en T1, NO miembro de T2.
--   1) header = T1 (su gym)     → get_my_tenant_id = T1.
--   2) header = T2 (gym ajeno)  → NO cruza: cae en T1 (CRÍTICO).
--   3) sin header               → T1 (comportamiento actual).
--   4) is_admin en su gym       → true.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_multigym_f2()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_t1 uuid; v_t2 uuid; v_auth uuid := gen_random_uuid(); v_u1 uuid; v_res uuid; v_adm boolean;
  v_slug1 text := 'zz-mg1-'||substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-mg2-'||substr(md5(random()::text),1,6);
BEGIN
  INSERT INTO tenants(slug,nombre,vertical,status) VALUES (v_slug1,'T1','gym_libre','activo') RETURNING id INTO v_t1;
  INSERT INTO tenants(slug,nombre,vertical,status) VALUES (v_slug2,'T2','gym_libre','activo') RETURNING id INTO v_t2;

  INSERT INTO auth.users(id,instance_id,aud,role,email,raw_user_meta_data,encrypted_password,email_confirmed_at,created_at,updated_at)
  VALUES (v_auth,'00000000-0000-0000-0000-000000000000','authenticated','authenticated', v_slug1||'-a@x.dev',
          jsonb_build_object('tenant_slug',v_slug1,'nombre','A'), '', now(),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth RETURNING id INTO v_u1;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_t1::text)::text, true);
  v_res := get_my_tenant_id();
  prueba:='1. header del gym propio → ese gym';
  resultado := CASE WHEN v_res=v_t1 THEN '✅' ELSE '❌ '||COALESCE(v_res::text,'null') END; RETURN NEXT;

  PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_t2::text)::text, true);
  v_res := get_my_tenant_id();
  prueba:='2. header de gym AJENO → NO cruza';
  resultado := CASE WHEN v_res=v_t1 THEN '✅ se quedó en el propio'
                    WHEN v_res=v_t2 THEN '❌❌ FUGA: devolvió el ajeno'
                    ELSE '❌ '||COALESCE(v_res::text,'null') END; RETURN NEXT;

  PERFORM set_config('request.headers', NULL, true);
  v_res := get_my_tenant_id();
  prueba:='3. sin header → su gym (actual)';
  resultado := CASE WHEN v_res=v_t1 THEN '✅' ELSE '❌ '||COALESCE(v_res::text,'null') END; RETURN NEXT;

  PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_t1::text)::text, true);
  v_adm := is_admin();
  prueba:='4. is_admin en su gym → true';
  resultado := CASE WHEN v_adm THEN '✅' ELSE '❌' END; RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM set_config('request.headers', NULL, true);
  PERFORM cerrar_tenant(v_slug1);
  PERFORM cerrar_tenant(v_slug2);
  DELETE FROM auth.users WHERE id = v_auth;
  RETURN;
END $$;

SELECT * FROM _diag_multigym_f2();
DROP FUNCTION _diag_multigym_f2();
