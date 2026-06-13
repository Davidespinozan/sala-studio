-- ============================================================================
-- FIX — trigger de signup: no caer a sala-demo en silencio.
-- ----------------------------------------------------------------------------
-- handle_new_auth_user caía a sala-demo con solo un RAISE NOTICE si el
-- tenant_slug del metadata no resolvía. Eso enmascaraba el bug del signup del
-- socio (se creaba en el tenant equivocado sin error visible). Ahora:
--   - tenant_slug presente y NO resuelve → RAISE EXCEPTION (aborta el signup).
--   - tenant_slug ausente → fallback a sala-demo (signup directo / marketing /
--     admin-create-user que setea sala-demo y luego reasigna).
-- ============================================================================

CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_meta_slug text;
  v_nombre text;
  v_telefono text;
BEGIN
  v_meta_slug := NULLIF(trim(NEW.raw_user_meta_data->>'tenant_slug'), '');

  IF v_meta_slug IS NOT NULL THEN
    -- Slug explícito → DEBE existir. Si no, abortar (no enmascarar).
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = v_meta_slug;
    IF v_tenant_id IS NULL THEN
      RAISE EXCEPTION 'TENANT_SLUG_INVALIDO: el gimnasio "%" no existe', v_meta_slug;
    END IF;
  ELSE
    -- Sin slug → fallback a sala-demo (signup directo / marketing).
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'sala-demo';
  END IF;

  v_nombre := NEW.raw_user_meta_data->>'nombre';
  v_telefono := NEW.raw_user_meta_data->>'telefono';

  INSERT INTO usuarios (
    auth_id, tenant_id, email, nombre, telefono, rol, status
  ) VALUES (
    NEW.id, v_tenant_id, NEW.email, v_nombre, v_telefono, 'miembro', 'pendiente_onboarding'
  )
  ON CONFLICT (tenant_id, email) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_auth_user();

-- ============================================================================
-- TEST — slug válido crea en ese tenant; slug inválido aborta. Savepoint.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid; v_slug text;
  v_auth_ok uuid := gen_random_uuid();
  v_auth_bad uuid := gen_random_uuid();
  v_tid uuid; v_fallo boolean := false;
BEGIN
  SELECT id, slug INTO v_tenant, v_slug FROM tenants WHERE status = 'activo' LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay tenants activos.'; RETURN; END IF;

  BEGIN
    -- Slug válido → usuario en ese tenant.
    INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth_ok, 'authenticated', 'authenticated',
            'trg-ok-'||substr(v_auth_ok::text,1,8)||'@test.local',
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Trg OK'), now(), now());
    SELECT tenant_id INTO v_tid FROM usuarios WHERE auth_id = v_auth_ok;
    IF v_tid <> v_tenant THEN RAISE EXCEPTION 'TEST FALLO: usuario no quedó en el tenant del slug.'; END IF;

    -- Slug inválido → el trigger aborta el INSERT.
    BEGIN
      INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000000', v_auth_bad, 'authenticated', 'authenticated',
              'trg-bad-'||substr(v_auth_bad::text,1,8)||'@test.local',
              '{"provider":"email","providers":["email"]}'::jsonb,
              jsonb_build_object('tenant_slug', '__no_existe__', 'nombre', 'Trg Bad'), now(), now());
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'TENANT_SLUG_INVALIDO%' THEN v_fallo := true; ELSE RAISE; END IF;
    END;
    IF NOT v_fallo THEN RAISE EXCEPTION 'TEST FALLO: un slug inválido no abortó el signup.'; END IF;

    RAISE EXCEPTION 'ROLLBACK_TRG';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_TRG' THEN NULL; ELSE RAISE; END IF;
  END;

  RAISE NOTICE 'TEST OK: slug válido crea en su tenant; slug inválido aborta el signup. Revertido.';
END $$;
