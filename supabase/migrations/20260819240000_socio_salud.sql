-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Historial de salud del socio: antecedentes + contacto de emergencia (por-tenant)
-- ----------------------------------------------------------------------------
-- Studio Pole Sport (Alejandra) pide que en el registro el socio capture antecedentes
-- clínicos/físicos y un contacto de emergencia (Pole/Pilates con acondicionamiento
-- clínico). Es dato SENSIBLE (salud), así que vive en su propia tabla con RLS estricto
-- —no en `usuarios` (evita la trampa de columnas + le da su propio permiso).
--
-- Se activa por tenant con el flag `config.registro.pide_salud` (bool). Sin el flag, el
-- formulario no aparece (los demás gyms no lo piden). Nada hardcodeado por slug.
--
-- Lectura: RLS (el socio ve lo suyo; el staff, lo de su tenant). Escritura: por el RPC
-- guardar_socio_salud (el socio guarda lo suyo; el staff, cualquiera de su tenant).
-- ============================================================================

CREATE TABLE IF NOT EXISTS socio_salud (
  usuario_id                        uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  tenant_id                         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contacto_emergencia_nombre        text,
  contacto_emergencia_tel           text,
  antecedentes_clinicos             text,
  antecedentes_musculoesqueleticos  text,
  tiene_condicion                   boolean NOT NULL DEFAULT false,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS socio_salud_tenant_idx ON socio_salud (tenant_id);

ALTER TABLE socio_salud ENABLE ROW LEVEL SECURITY;

-- Lectura: el socio ve lo suyo; el staff (admin/recepción), lo de su tenant.
DROP POLICY IF EXISTS socio_salud_read_self ON socio_salud;
CREATE POLICY socio_salud_read_self ON socio_salud
  FOR SELECT TO authenticated
  USING (usuario_id = get_my_user_id());

DROP POLICY IF EXISTS socio_salud_read_staff ON socio_salud;
CREATE POLICY socio_salud_read_staff ON socio_salud
  FOR SELECT TO authenticated
  USING (is_recepcionista() AND tenant_id = get_my_tenant_id());

-- Escritura: solo por el RPC (SECURITY DEFINER). Sin policies de INSERT/UPDATE directas.


CREATE OR REPLACE FUNCTION guardar_socio_salud(
  p_usuario_id uuid,
  p_contacto_nombre text DEFAULT NULL,
  p_contacto_tel text DEFAULT NULL,
  p_antecedentes_clinicos text DEFAULT NULL,
  p_antecedentes_musculo text DEFAULT NULL,
  p_tiene_condicion boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_tenant uuid;
BEGIN
  v_actor := get_my_user_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: usuario no autenticado';
  END IF;

  -- El socio solo puede guardar lo SUYO; el staff, cualquiera de su tenant.
  IF p_usuario_id <> v_actor AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: no puedes editar la salud de otro socio';
  END IF;

  SELECT tenant_id INTO v_tenant FROM usuarios WHERE id = p_usuario_id;
  IF v_tenant IS NULL OR v_tenant <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: el socio no pertenece a tu gimnasio';
  END IF;

  INSERT INTO socio_salud (
    usuario_id, tenant_id, contacto_emergencia_nombre, contacto_emergencia_tel,
    antecedentes_clinicos, antecedentes_musculoesqueleticos, tiene_condicion, updated_at
  ) VALUES (
    p_usuario_id, v_tenant, NULLIF(trim(p_contacto_nombre), ''), NULLIF(trim(p_contacto_tel), ''),
    NULLIF(trim(p_antecedentes_clinicos), ''), NULLIF(trim(p_antecedentes_musculo), ''),
    COALESCE(p_tiene_condicion, false), now()
  )
  ON CONFLICT (usuario_id) DO UPDATE SET
    contacto_emergencia_nombre       = NULLIF(trim(p_contacto_nombre), ''),
    contacto_emergencia_tel          = NULLIF(trim(p_contacto_tel), ''),
    antecedentes_clinicos            = NULLIF(trim(p_antecedentes_clinicos), ''),
    antecedentes_musculoesqueleticos = NULLIF(trim(p_antecedentes_musculo), ''),
    tiene_condicion                  = COALESCE(p_tiene_condicion, false),
    updated_at                       = now();
END;
$$;

REVOKE ALL ON FUNCTION guardar_socio_salud(uuid, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION guardar_socio_salud(uuid, text, text, text, text, boolean) TO authenticated;


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) el socio guarda lo SUYO → se guarda.
--   2) el staff guarda para un socio de su tenant → se actualiza.
--   3) un socio NO puede guardar la salud de OTRO socio → bloqueado.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_socio_salud()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_auth_admin uuid := gen_random_uuid(); v_auth_a uuid := gen_random_uuid();
  v_admin uuid; v_a uuid; v_b uuid;
  v_slug text := 'zz-test-salud-' || substr(md5(random()::text), 1, 6);
  v_val text; v_r text; v_ok3 text := '(no corrió)';
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test salud', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  -- admin (con auth) + socio A (con auth, para probar como socio) + socio B.
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          v_slug||'-admin@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'), '', now(), now(), now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id = v_auth_admin RETURNING id INTO v_admin;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          v_slug||'-a@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Socio A'), '', now(), now(), now());
  UPDATE usuarios SET rol='miembro', status='activo' WHERE auth_id = v_auth_a RETURNING id INTO v_a;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug||'-b@x.dev', 'Socio B', 'miembro', 'activo') RETURNING id INTO v_b;

  -- 1) El socio A guarda lo suyo.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_a::text)::text, true);
  PERFORM guardar_socio_salud(v_a, 'Mamá de A', '6671112222', 'Ninguna', 'Cirugía de rodilla 2024', true);
  SELECT antecedentes_musculoesqueleticos INTO v_val FROM socio_salud WHERE usuario_id = v_a;

  prueba := '1. socio guarda lo suyo';
  resultado := CASE WHEN v_val = 'Cirugía de rodilla 2024' THEN '✅ guardado' ELSE '❌ ' || COALESCE(v_val,'NULL') END; RETURN NEXT;

  -- 3) El socio A intenta guardar la salud del socio B → bloqueado (sigue como socio A).
  BEGIN
    PERFORM guardar_socio_salud(v_b, 'Hacker', '000', 'x', 'x', false);
    v_ok3 := '❌ dejó editar a otro socio';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_r = MESSAGE_TEXT;
    v_ok3 := CASE WHEN v_r LIKE 'NO_AUTORIZADO%' THEN '✅ bloqueó' ELSE '⚠ otro: ' || v_r END;
  END;

  -- 2) El staff guarda para el socio B.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_admin::text)::text, true);
  PERFORM guardar_socio_salud(v_b, 'Contacto B', '6673334444', 'Asma', 'Ninguno', false);
  SELECT contacto_emergencia_nombre INTO v_val FROM socio_salud WHERE usuario_id = v_b;

  prueba := '2. staff guarda para un socio del tenant';
  resultado := CASE WHEN v_val = 'Contacto B' THEN '✅ guardado' ELSE '❌ ' || COALESCE(v_val,'NULL') END; RETURN NEXT;

  prueba := '3. socio NO puede editar salud de otro socio';
  resultado := v_ok3; RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
  RETURN;
END $$;

SELECT * FROM _diag_socio_salud();
DROP FUNCTION _diag_socio_salud();
