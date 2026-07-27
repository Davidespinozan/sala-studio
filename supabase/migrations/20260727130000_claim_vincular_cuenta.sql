-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- RECLAMAR CUENTA — vincular un auth nuevo a la ficha que ya existe (sin auth).
-- ────────────────────────────────────────────────────────────────────────────
-- Un socio IMPORTADO (o invitado por el admin) tiene su fila en `usuarios` con
-- auth_id NULL. Cuando por fin crea su login con su email, el trigger de signup
-- chocaba con el UNIQUE (tenant_id, email) y hacía DO NOTHING: el auth quedaba
-- creado pero SIN vincular → el socio no podía ver su propia cuenta.
--
-- Ahora, ante ese choque, si la fila existente NO tiene auth (es una ficha
-- pendiente de reclamo), se le ENGANCHA el auth_id. Así el socio importado entra
-- directo a su membresía. Si la fila YA tiene auth (cuenta real), no se toca
-- (no se secuestra una cuenta ajena) — el WHERE lo garantiza.
--
-- Es un cambio de UNA cláusula sobre handle_new_auth_user; el resto queda igual
-- que en 20260613002200 (slug estricto).
-- ════════════════════════════════════════════════════════════════════════════

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
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = v_meta_slug;
    IF v_tenant_id IS NULL THEN
      RAISE EXCEPTION 'TENANT_SLUG_INVALIDO: el gimnasio "%" no existe', v_meta_slug;
    END IF;
  ELSE
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'sala-demo';
  END IF;

  v_nombre := NEW.raw_user_meta_data->>'nombre';
  v_telefono := NEW.raw_user_meta_data->>'telefono';

  INSERT INTO usuarios (
    auth_id, tenant_id, email, nombre, telefono, rol, status
  ) VALUES (
    NEW.id, v_tenant_id, NEW.email, v_nombre, v_telefono, 'miembro', 'pendiente_onboarding'
  )
  -- Reclamo: si ya hay una ficha con ese email en el tenant y está SIN auth
  -- (importada/invitada), se le engancha este login. Si ya tiene auth, se
  -- ignora (no se pisa una cuenta real). No se toca nombre/status/membresía:
  -- el socio importado entra tal cual, activo y con su plan.
  ON CONFLICT (tenant_id, email) DO UPDATE
    SET auth_id = EXCLUDED.auth_id
    WHERE usuarios.auth_id IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_auth_user();

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA y se revierte. Corré esto aparte para verificar:
--
--   BEGIN;
--   WITH t AS (SELECT id, slug FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1)
--   INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
--   SELECT id, 'claim-test@example.com', 'Claim Test', 'miembro', 'activo' FROM t;
--
--   INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
--   SELECT '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
--          'claim-test@example.com', '{"provider":"email","providers":["email"]}'::jsonb,
--          jsonb_build_object('tenant_slug', slug), now(), now()
--   FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
--
--   SELECT email,
--          (auth_id IS NOT NULL) AS vinculado,   -- esperado: true
--          status,                                -- esperado: activo (no lo pisó)
--          (SELECT count(*) FROM usuarios WHERE email='claim-test@example.com') AS filas  -- esperado: 1
--   FROM usuarios WHERE email='claim-test@example.com';
--   ROLLBACK;
-- ════════════════════════════════════════════════════════════════════════════
