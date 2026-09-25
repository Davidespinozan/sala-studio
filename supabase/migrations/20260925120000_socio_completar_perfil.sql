-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- El SOCIO completa su propio perfil (teléfono + ficha privada) + aviso único
-- ----------------------------------------------------------------------------
-- El alta por recepción captura teléfono, nacimiento, sexo y domicilio; el alta
-- self-service los omite. Para que el socio pueda completarlos desde la app:
--   1) socio_actualizar_perfil: escribe SU teléfono (usuarios) + SU ficha privada
--      (usuarios_datos_privados) — el socio hoy solo tiene SELECT de esa tabla.
--   2) avisar_completar_perfil: crea UNA notificación 'completar_perfil' (push) si
--      su perfil está incompleto y aún no tiene una. El front la llama al entrar.
-- Molde: guardar_socio_salud (20260819240000). Escritura solo por RPC.
-- ============================================================================

CREATE OR REPLACE FUNCTION socio_actualizar_perfil(
  p_telefono text DEFAULT NULL,
  p_fecha_nacimiento date DEFAULT NULL,
  p_sexo text DEFAULT NULL,
  p_domicilio text DEFAULT NULL
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

  SELECT tenant_id INTO v_tenant FROM usuarios WHERE id = v_actor;
  IF v_tenant IS NULL OR v_tenant <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: sin tenant válido';
  END IF;

  -- Teléfono en `usuarios` (su propia fila).
  UPDATE usuarios
  SET telefono = NULLIF(trim(p_telefono), '')
  WHERE id = v_actor;

  -- Ficha privada (nacimiento/sexo/domicilio). El CHECK de sexo lo impone la tabla.
  INSERT INTO usuarios_datos_privados (usuario_id, tenant_id, fecha_nacimiento, sexo, domicilio)
  VALUES (v_actor, v_tenant, p_fecha_nacimiento, NULLIF(trim(p_sexo), ''), NULLIF(trim(p_domicilio), ''))
  ON CONFLICT (usuario_id) DO UPDATE SET
    fecha_nacimiento = p_fecha_nacimiento,
    sexo             = NULLIF(trim(p_sexo), ''),
    domicilio        = NULLIF(trim(p_domicilio), '');
END;
$$;

REVOKE ALL ON FUNCTION socio_actualizar_perfil(text, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION socio_actualizar_perfil(text, date, text, text) TO authenticated;


-- Aviso "completa tu perfil": UNA sola notificación por socio, si está incompleto.
CREATE OR REPLACE FUNCTION avisar_completar_perfil()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_tenant uuid;
  v_incompleto boolean;
BEGIN
  v_actor := get_my_user_id();
  IF v_actor IS NULL THEN RETURN; END IF; -- fire-and-forget: sin sesión, no hace nada

  SELECT tenant_id INTO v_tenant FROM usuarios WHERE id = v_actor;
  IF v_tenant IS NULL THEN RETURN; END IF;

  -- Incompleto = sin teléfono O sin fecha de nacimiento (los obligatorios).
  v_incompleto :=
    (SELECT telefono IS NULL FROM usuarios WHERE id = v_actor)
    OR NOT EXISTS (
      SELECT 1 FROM usuarios_datos_privados
      WHERE usuario_id = v_actor AND fecha_nacimiento IS NOT NULL
    );

  IF NOT v_incompleto THEN RETURN; END IF;

  -- Dedupe: una sola vez por socio (patrón felicitaciones).
  IF EXISTS (
    SELECT 1 FROM notificaciones
    WHERE usuario_id = v_actor AND tipo = 'completar_perfil'
  ) THEN RETURN; END IF;

  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje)
  VALUES (
    v_tenant, v_actor, 'completar_perfil',
    'Completa tu perfil',
    'Faltan algunos datos (teléfono y fecha de nacimiento) para tu cuenta. Complétalos en tu perfil.'
  );
END;
$$;

REVOKE ALL ON FUNCTION avisar_completar_perfil() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION avisar_completar_perfil() TO authenticated;


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) el socio guarda su teléfono + nacimiento → se guardan.
--   2) avisar_completar_perfil crea el aviso si está incompleto…
--   3) …y NO lo duplica en una segunda llamada.
--   4) socio ya completo → no genera aviso.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_completar_perfil()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_auth_a uuid := gen_random_uuid(); v_auth_b uuid := gen_random_uuid();
  v_a uuid; v_b uuid;
  v_slug text := 'zz-test-perfil-' || substr(md5(random()::text), 1, 6);
  v_tel text; v_nac date; v_n integer;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test perfil', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  -- Socio A (incompleto, con auth para actuar como él).
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          v_slug||'-a@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Socio A'), '', now(), now(), now());
  UPDATE usuarios SET rol='miembro', status='activo', telefono=NULL WHERE auth_id = v_auth_a RETURNING id INTO v_a;

  -- Socio B (quedará completo para la prueba 4).
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          v_slug||'-b@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Socio B'), '', now(), now(), now());
  UPDATE usuarios SET rol='miembro', status='activo' WHERE auth_id = v_auth_b RETURNING id INTO v_b;

  -- 1) A guarda su perfil.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_a::text)::text, true);
  PERFORM socio_actualizar_perfil('6671234567', date '1995-04-10', 'femenino', 'Calle 1');
  SELECT telefono INTO v_tel FROM usuarios WHERE id = v_a;
  SELECT fecha_nacimiento INTO v_nac FROM usuarios_datos_privados WHERE usuario_id = v_a;
  prueba := '1. socio guarda teléfono + nacimiento';
  resultado := CASE WHEN v_tel = '6671234567' AND v_nac = date '1995-04-10' THEN '✅ guardado'
                    ELSE '❌ tel=' || COALESCE(v_tel,'NULL') || ' nac=' || COALESCE(v_nac::text,'NULL') END; RETURN NEXT;

  -- 2) y 3) B (incompleto) genera aviso una sola vez.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_b::text)::text, true);
  PERFORM avisar_completar_perfil();
  PERFORM avisar_completar_perfil();
  SELECT count(*) INTO v_n FROM notificaciones WHERE usuario_id = v_b AND tipo = 'completar_perfil';
  prueba := '2-3. aviso incompleto, único (no duplica)';
  resultado := CASE WHEN v_n = 1 THEN '✅ 1 aviso' ELSE '❌ ' || v_n || ' avisos' END; RETURN NEXT;

  -- 4) A (ya completo por la prueba 1) NO genera aviso.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_a::text)::text, true);
  PERFORM avisar_completar_perfil();
  SELECT count(*) INTO v_n FROM notificaciones WHERE usuario_id = v_a AND tipo = 'completar_perfil';
  prueba := '4. socio completo → sin aviso';
  resultado := CASE WHEN v_n = 0 THEN '✅ 0 avisos' ELSE '❌ ' || v_n || ' avisos' END; RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
  RETURN;
END $$;

SELECT * FROM _diag_completar_perfil();
DROP FUNCTION _diag_completar_perfil();
