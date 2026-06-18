-- ============================================================================
-- "Vista login" del demo: socio de ejemplo con credenciales públicas
-- ----------------------------------------------------------------------------
-- Crea UNA cuenta socio real (email + contraseña) en healthyspace para que el
-- visitante pueda probar el flujo de inicio de sesión desde "Probar demo".
--
--   email:    demo@healthyspace.app
--   password: demo1234
--
-- Persistente: created_at backdated para que el reset nocturno (que borra socios
-- recientes) NO la toque. Rol miembro, acotada a healthyspace por RLS/guardrails
-- → aunque sea pública, solo puede hacer cosas de socio en el gym de ejemplo.
-- Idempotente: si ya existe, no la recrea.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$
DECLARE
  v_uid   uuid := 'de300000-0000-4000-a000-000000000001';
  v_demo  uuid;
  v_user  uuid;
  v_tier_id uuid;
  v_tier_slug text;
  v_mem   uuid;
  v_back  timestamptz := '2026-01-01 00:00:00+00';
BEGIN
  SELECT id INTO v_demo FROM tenants WHERE slug = 'healthyspace';
  IF v_demo IS NULL THEN
    RAISE EXCEPTION 'healthyspace no existe; no se puede crear el socio demo.';
  END IF;

  -- 1) Usuario de auth con contraseña. El trigger handle_new_auth_user crea la
  --    fila en `usuarios` (miembro, healthyspace). email ya confirmado.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid) THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      v_uid, 'authenticated', 'authenticated',
      'demo@healthyspace.app',
      extensions.crypt('demo1234', extensions.gen_salt('bf')),
      now(), v_back, now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"nombre":"Socio Demo"}'::jsonb,
      '', '', '', ''
    );
  END IF;

  -- 2) Fila de usuarios (creada por el trigger). Activar + backdate.
  SELECT id INTO v_user FROM usuarios WHERE auth_id = v_uid;
  IF v_user IS NULL THEN
    INSERT INTO usuarios (auth_id, tenant_id, email, nombre, rol, status, created_at)
    VALUES (v_uid, v_demo, 'demo@healthyspace.app', 'Socio Demo', 'miembro', 'activo', v_back)
    RETURNING id INTO v_user;
  ELSE
    UPDATE usuarios
    SET tenant_id = v_demo, nombre = 'Socio Demo', rol = 'miembro',
        status = 'activo', created_at = v_back
    WHERE id = v_user;
  END IF;

  -- 3) Membresía activa backdated (mismo criterio que provisionar_demo: el tier
  --    activo más caro). Sin esto el socio no podría reservar.
  IF NOT EXISTS (SELECT 1 FROM membresias WHERE usuario_id = v_user AND status = 'activa') THEN
    SELECT id, slug INTO v_tier_id, v_tier_slug
    FROM tiers WHERE tenant_id = v_demo AND activo = true
    ORDER BY precio_centavos DESC LIMIT 1;

    IF v_tier_id IS NOT NULL THEN
      INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, created_at)
      VALUES (v_demo, v_user, v_tier_id, 'activa', now(), now() + interval '365 days', v_back)
      RETURNING id INTO v_mem;
      UPDATE usuarios SET membresia_activa_id = v_mem, membresia_tier = v_tier_slug WHERE id = v_user;
    END IF;
  END IF;

  RAISE NOTICE 'Socio demo listo: demo@healthyspace.app / demo1234';
END;
$$;
