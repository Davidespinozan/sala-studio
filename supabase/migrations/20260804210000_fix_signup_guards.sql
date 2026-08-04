-- ── Fix disponibilidad: signups anónimos / de onboarding fallaban ─────────────
-- handle_new_auth_user perdió sus early-returns. Cuando un signup NO trae
-- `tenant_slug` (registro anónimo de demo, o el signup del onboarding de un gym
-- nuevo), caía al fallback `slug='sala-demo'` — que YA está borrado → tenant_id
-- NULL → INSERT a usuarios viola NOT NULL → el signup ENTERO falla.
--
-- Cambio QUIRÚRGICO: se agregan SOLO los dos early-returns; el resto del cuerpo
-- queda idéntico. La ruta normal (socio con tenant_slug) NO se toca. Se usa
-- CREATE OR REPLACE (el trigger on_auth_user_created sigue apuntando aquí, no se
-- recrea → no hay ventana sin trigger).
--
-- Verdad de campo (confirmada en el código):
--   • anónimo    → supabase.auth.signInAnonymously()  → NEW.is_anonymous = true
--   • onboarding → createUser(user_metadata:{onboarding:'true'})  (el gym se crea
--                  después vía crear_tenant_onboarding; el trigger debe saltarlo)

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
  -- Signups que NO deben crear ficha de socio (sin esto caían al 'sala-demo'
  -- borrado y el registro entero fallaba):
  IF COALESCE(NEW.is_anonymous, false) THEN
    RETURN NEW;
  END IF;
  IF NEW.raw_user_meta_data->>'onboarding' = 'true' THEN
    RETURN NEW;
  END IF;

  v_meta_slug := NULLIF(trim(NEW.raw_user_meta_data->>'tenant_slug'), '');

  IF v_meta_slug IS NOT NULL THEN
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = v_meta_slug;
    IF v_tenant_id IS NULL THEN
      RAISE EXCEPTION 'TENANT_SLUG_INVALIDO: el gimnasio "%" no existe', v_meta_slug;
    END IF;
  ELSE
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'sala-demo';
  END IF;

  v_nombre := NEW.raw_user_meta_data->>'nombre';
  v_telefono := NEW.raw_user_meta_data->>'telefono';

  -- DO NOTHING: si ya hay una ficha con ese email, NO se vincula sola (la
  -- vinculación pasa por reclamar-cuenta). Así un signUp hostil con el email de
  -- un socio no hereda su ficha.
  INSERT INTO usuarios (
    auth_id, tenant_id, email, nombre, telefono, rol, status
  ) VALUES (
    NEW.id, v_tenant_id, NEW.email, v_nombre, v_telefono, 'miembro', 'pendiente_onboarding'
  )
  ON CONFLICT (tenant_id, email) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ── Self-test (devuelve tabla): la función tiene los dos guards ───────────────
SELECT
  (position('is_anonymous' in p.prosrc) > 0) AS guard_anonimo,
  (position('onboarding'   in p.prosrc) > 0) AS guard_onboarding
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'handle_new_auth_user';
