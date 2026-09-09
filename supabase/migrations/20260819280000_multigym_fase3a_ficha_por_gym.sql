-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- MULTI-GYM · FASE 3a — una persona puede tener ficha en varios gyms
-- ----------------------------------------------------------------------------
-- Hoy `usuarios.auth_id` es ÚNICO → un login = un gym. Para que la misma persona
-- (mismo correo/login) sea socia de varios gyms, se cambia a ÚNICO por (auth_id,
-- tenant_id): una ficha por persona POR gym (nunca dos en el mismo gym).
--
-- Seguro para numa: hoy cada auth_id es único, así que el nuevo constraint compuesto
-- se cumple sin cambios. Nadie obtiene una 2ª ficha en esta fase (eso lo hace el
-- signup en la Fase 3b). Reversible: volver a UNIQUE(auth_id) si hiciera falta.
-- La resolución del gym activo ya la maneja _usuario_activo_id (Fase 2, por header).
-- ============================================================================

-- Quita el UNIQUE de una sola columna (auth_id), sea cual sea su nombre.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'usuarios' AND con.contype = 'u'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
           FROM unnest(con.conkey) k
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k)
          = ARRAY['auth_id']::text[]
  LOOP
    EXECUTE format('ALTER TABLE usuarios DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- Único por persona POR gym (auth_id NULL sigue permitiendo varios sin login).
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_auth_id_tenant_key;
ALTER TABLE usuarios ADD  CONSTRAINT usuarios_auth_id_tenant_key UNIQUE (auth_id, tenant_id);


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) la misma persona (auth) puede tener ficha en T1 y en T2.
--   2) NO puede tener dos fichas en el MISMO gym (viola el único compuesto).
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_multigym_f3a()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_t1 uuid; v_t2 uuid; v_auth uuid := gen_random_uuid(); v_r text;
  v_slug1 text := 'zz-3a1-'||substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-3a2-'||substr(md5(random()::text),1,6);
  v_ok1 text; v_ok2 text;
BEGIN
  BEGIN
    INSERT INTO tenants(slug,nombre,vertical,status) VALUES (v_slug1,'T1','gym_libre','activo') RETURNING id INTO v_t1;
    INSERT INTO tenants(slug,nombre,vertical,status) VALUES (v_slug2,'T2','gym_libre','activo') RETURNING id INTO v_t2;

    -- auth real (el trigger crea la ficha en T1). auth_id tiene FK a auth.users.
    INSERT INTO auth.users(id,instance_id,aud,role,email,raw_user_meta_data,encrypted_password,email_confirmed_at,created_at,updated_at)
    VALUES (v_auth,'00000000-0000-0000-0000-000000000000','authenticated','authenticated', v_slug1||'-p@x.dev',
            jsonb_build_object('tenant_slug',v_slug1,'nombre','P'), '', now(),now(),now());

    -- 2ª ficha en OTRO gym (T2) con el MISMO auth_id → debe permitir.
    INSERT INTO usuarios(tenant_id,auth_id,email,nombre,rol,status) VALUES (v_t2,v_auth,v_slug2||'-p@x.dev','P','miembro','activo');
    v_ok1 := '✅ misma persona en T1 y T2';

    -- Segunda ficha en el MISMO gym (T1) → debe fallar.
    BEGIN
      INSERT INTO usuarios(tenant_id,auth_id,email,nombre,rol,status) VALUES (v_t1,v_auth,v_slug1||'-p2@x.dev','P','miembro','activo');
      v_ok2 := '❌ permitió 2 fichas en el mismo gym';
    EXCEPTION WHEN unique_violation THEN
      v_ok2 := '✅ bloqueó 2ª ficha en el mismo gym';
    END;

    RAISE EXCEPTION 'ROLLBACK_3A';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_3A' THEN
      prueba:='montaje'; resultado:='❌ '||SQLERRM; RETURN NEXT; RETURN;
    END IF;
  END;
  prueba:='1. misma persona en varios gyms'; resultado:=v_ok1; RETURN NEXT;
  prueba:='2. no 2 fichas en el mismo gym';   resultado:=v_ok2; RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_multigym_f3a();
DROP FUNCTION _diag_multigym_f3a();
