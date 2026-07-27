-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- ACTIVACIÓN DE CUENTA POR CÓDIGO — cierra la toma de cuenta con solo el email.
-- ────────────────────────────────────────────────────────────────────────────
-- Antes, el trigger de signup vinculaba la ficha huérfana al PRIMER auth_id que
-- se registrara con ese email (revisión: toma de cuenta / squatting conociendo el
-- email + slug público). Ahora:
--
--   1. El trigger VUELVE a DO NOTHING: un signup con un email que ya existe como
--      ficha ya NO hereda la ficha (queda una cuenta vacía, inservible). Mata el
--      atajo de signUp directo.
--   2. La vinculación real la hace SOLO la función reclamar-cuenta, que exige un
--      CÓDIGO de activación que recepción le entrega al socio en persona.
--
-- Este archivo: revierte el trigger + crea codigos_activacion + la RPC que
-- recepción usa para generar el código. La vinculación explícita vive en la
-- función reclamar-cuenta (fuera de este SQL).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1) Trigger: dejar de auto-vincular (volver a DO NOTHING) ─────────────────
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

  -- DO NOTHING: si ya hay una ficha con ese email, NO se vincula sola. El reclamo
  -- de una ficha existente pasa SOLO por reclamar-cuenta (con código). Así un
  -- signUp hostil con el email de un socio no hereda su ficha.
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

-- ── 2) Tabla de códigos de activación ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS codigos_activacion (
  usuario_id uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  codigo     text NOT NULL,
  expira_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE codigos_activacion ENABLE ROW LEVEL SECURITY;

-- Staff del gym: ver/gestionar los códigos de sus socios (para dárselos).
DROP POLICY IF EXISTS codigos_staff ON codigos_activacion;
CREATE POLICY codigos_staff ON codigos_activacion
  FOR ALL TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- ── 3) RPC: recepción genera (o refresca) el código de un socio pendiente ────
CREATE OR REPLACE FUNCTION generar_codigo_activacion(p_usuario_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller usuarios;
  v_socio usuarios;
  v_codigo text;
  v_expira timestamptz;
BEGIN
  SELECT * INTO v_caller FROM usuarios WHERE auth_id = auth.uid();
  IF v_caller.id IS NULL OR v_caller.rol NOT IN ('admin', 'recepcionista') OR v_caller.status <> 'activo' THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL OR v_socio.tenant_id <> v_caller.tenant_id THEN
    RAISE EXCEPTION 'SOCIO_INVALIDO';
  END IF;
  IF v_socio.auth_id IS NOT NULL THEN
    RAISE EXCEPTION 'YA_TIENE_CUENTA';
  END IF;
  IF v_socio.email IS NULL OR v_socio.email LIKE '%@sin-correo.local' THEN
    RAISE EXCEPTION 'SIN_EMAIL';  -- primero ponle su correo real en la ficha
  END IF;

  -- Código de 6 caracteres hex en mayúscula (sin O/I/L ambiguos).
  v_codigo := upper(substr(md5(gen_random_uuid()::text), 1, 6));
  v_expira := now() + interval '7 days';

  INSERT INTO codigos_activacion (usuario_id, tenant_id, codigo, expira_at)
  VALUES (p_usuario_id, v_socio.tenant_id, v_codigo, v_expira)
  ON CONFLICT (usuario_id) DO UPDATE
    SET codigo = EXCLUDED.codigo, expira_at = EXCLUDED.expira_at, created_at = now();

  RETURN jsonb_build_object('codigo', v_codigo, 'expira_at', v_expira);
END; $$;

-- La valida el propio RPC (rol adentro); authenticated puede llamarla.
REVOKE ALL ON FUNCTION generar_codigo_activacion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION generar_codigo_activacion(uuid) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA.
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'trigger DO NOTHING + codigos_activacion + RPC' AS prueba,
  (SELECT pg_get_functiondef(oid) LIKE '%DO NOTHING%'
     FROM pg_proc WHERE proname = 'handle_new_auth_user') AS trigger_no_autovincula,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'codigos_activacion') AS tabla_ok,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'generar_codigo_activacion') AS rpc_ok;
