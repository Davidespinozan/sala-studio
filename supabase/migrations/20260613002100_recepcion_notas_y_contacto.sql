-- ============================================================================
-- RECEPCIÓN — notas con autor + editar contacto del socio.
-- ----------------------------------------------------------------------------
-- Cierra los 2 pendientes del módulo: notas con autor/fecha (antes era un blob
-- usuarios.notas_admin sin autor) y editar el contacto (tel/email) desde
-- recepción. Ambos RPCs escriben en la bitácora (verbos socio.nota /
-- socio.editar_contacto, ya en el enum).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- A) Tabla socio_notas (append-only, autor + fecha).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS socio_notas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,  -- el socio
  autor_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  autor_nombre text,
  autor_rol text,
  texto text NOT NULL CHECK (length(trim(texto)) > 0),
  creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS socio_notas_usuario_idx ON socio_notas (usuario_id, creado_en DESC);

ALTER TABLE socio_notas ENABLE ROW LEVEL SECURITY;

-- Lectura: staff (recep/admin) del tenant. Escritura: solo vía RPC (DEFINER).
DROP POLICY IF EXISTS socio_notas_read_staff ON socio_notas;
CREATE POLICY socio_notas_read_staff ON socio_notas
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- ─────────────────────────────────────────────────────────────────────────────
-- B) recepcion_agregar_nota — agrega una nota con autor a un socio.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_agregar_nota(
  p_usuario_id uuid,
  p_texto text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_autor_id uuid; v_autor_nombre text; v_autor_rol text;
  v_socio usuarios;
  v_nota_id uuid;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden agregar notas';
  END IF;
  IF p_texto IS NULL OR length(trim(p_texto)) = 0 THEN
    RAISE EXCEPTION 'TEXTO_REQUERIDO: la nota no puede estar vacía';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN RAISE EXCEPTION 'SOCIO_NO_EXISTE: el socio no existe'; END IF;
  IF v_socio.tenant_id <> v_tenant THEN RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio'; END IF;

  SELECT id, nombre, rol INTO v_autor_id, v_autor_nombre, v_autor_rol
  FROM usuarios WHERE auth_id = auth.uid();

  INSERT INTO socio_notas (tenant_id, usuario_id, autor_id, autor_nombre, autor_rol, texto)
  VALUES (v_tenant, p_usuario_id, v_autor_id, v_autor_nombre, v_autor_rol, trim(p_texto))
  RETURNING id INTO v_nota_id;

  PERFORM _audrec_log(
    'socio.nota', 'socio', v_nota_id, p_usuario_id, v_socio.nombre,
    format('Agregó una nota a %s.', COALESCE(v_socio.nombre, v_socio.email)),
    jsonb_build_object('nota_id', v_nota_id, 'texto', trim(p_texto))
  );

  RETURN jsonb_build_object('success', true, 'nota_id', v_nota_id);
END $$;

REVOKE ALL ON FUNCTION recepcion_agregar_nota(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_agregar_nota(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- C) recepcion_editar_contacto — edita tel/email (contacto) del socio.
--    El email de ACCESO (auth.users) no cambia acá; esto es el contacto.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_editar_contacto(
  p_usuario_id uuid,
  p_telefono text,
  p_email text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_socio usuarios;
  v_tel text := NULLIF(trim(COALESCE(p_telefono, '')), '');
  v_email text := NULLIF(trim(lower(COALESCE(p_email, ''))), '');
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden editar el contacto';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN RAISE EXCEPTION 'SOCIO_NO_EXISTE: el socio no existe'; END IF;
  IF v_socio.tenant_id <> v_tenant THEN RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio'; END IF;

  IF v_email IS NOT NULL AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'EMAIL_INVALIDO: el email no tiene un formato válido';
  END IF;

  UPDATE usuarios
  SET telefono = v_tel,
      email = COALESCE(v_email, email),  -- no borramos el email si vino vacío
      updated_at = now()
  WHERE id = p_usuario_id;

  PERFORM _audrec_log(
    'socio.editar_contacto', 'socio', p_usuario_id, p_usuario_id, v_socio.nombre,
    format('Editó el contacto de %s.', COALESCE(v_socio.nombre, v_socio.email)),
    jsonb_build_object(
      'telefono_anterior', v_socio.telefono, 'telefono_nuevo', v_tel,
      'email_anterior', v_socio.email, 'email_nuevo', COALESCE(v_email, v_socio.email)
    )
  );

  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION recepcion_editar_contacto(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_editar_contacto(uuid, text, text) TO authenticated;

-- ============================================================================
-- TEST — agregar nota (con autor) y editar contacto, revertido. SKIP sin recep.
-- ============================================================================
DO $$
DECLARE
  v_recep uuid; v_recep_auth uuid; v_tenant uuid; v_slug text;
  v_auth_socio uuid := gen_random_uuid(); v_socio uuid;
  v_nota_autor uuid; v_tel text;
BEGIN
  SELECT id, auth_id, tenant_id INTO v_recep, v_recep_auth, v_tenant
  FROM usuarios WHERE rol = 'recepcionista' AND auth_id IS NOT NULL LIMIT 1;
  IF v_recep IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay recepcionista con auth_id.'; RETURN; END IF;
  SELECT slug INTO v_slug FROM tenants WHERE id = v_tenant;

  BEGIN
    INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth_socio, 'authenticated', 'authenticated',
            'nota-'||substr(v_auth_socio::text,1,8)||'@test.local',
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Nota Socio'), now(), now());
    SELECT id INTO v_socio FROM usuarios WHERE auth_id = v_auth_socio;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);

    PERFORM recepcion_agregar_nota(v_socio, 'Llamó para reprogramar.');
    SELECT autor_id INTO v_nota_autor FROM socio_notas WHERE usuario_id = v_socio ORDER BY creado_en DESC LIMIT 1;
    IF v_nota_autor <> v_recep THEN RAISE EXCEPTION 'TEST FALLO: la nota no guardó el autor correcto.'; END IF;

    PERFORM recepcion_editar_contacto(v_socio, '+52 55 1234 5678', NULL);
    SELECT telefono INTO v_tel FROM usuarios WHERE id = v_socio;
    IF v_tel <> '+52 55 1234 5678' THEN RAISE EXCEPTION 'TEST FALLO: el teléfono no se editó (%).', v_tel; END IF;

    RAISE EXCEPTION 'ROLLBACK_NOTAS';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_NOTAS' THEN NULL; ELSE RAISE; END IF;
  END;

  RAISE NOTICE 'TEST OK: agregar_nota guarda autor y editar_contacto actualiza el tel. Revertido.';
END $$;
