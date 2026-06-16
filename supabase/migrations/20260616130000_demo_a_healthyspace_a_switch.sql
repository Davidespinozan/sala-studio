-- ============================================================================
-- DEMO → HEALTHYSPACE (A: el switch, sin downtime)
-- ----------------------------------------------------------------------------
-- El demo público deja de ser `sala-demo` y pasa a ser el contenido ya armado
-- del tenant `santi`, presentado como "Healthy Space" en healthyspace.salastudio.app.
--
-- Esta migración:
--   1. Borra el tenant 'healthyspace' de PRUEBA que ya ocupaba ese slug (era un
--      experimento; libera el slug para santi).
--   2. Renombra el tenant santi → slug 'healthyspace', nombre 'Healthy Space'.
--   3. Repunta de 'sala-demo' a 'healthyspace' las funciones del demo
--      (provisionar_demo, reset_sala_demo, guardrails) y el fallback del trigger
--      de signup.
--
-- NO borra sala-demo todavía: queda como red de seguridad hasta validar que
-- healthyspace funciona (eso lo hace la migración B). Así el apex/marketing no
-- pierde su tenant fallback durante el deploy del código nuevo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Borrar el 'healthyspace' de prueba (libera el slug)
-- ----------------------------------------------------------------------------
-- Teardown ordenado por las FKs RESTRICT de usuarios/reservas (igual que la
-- migración B). En este punto slug='healthyspace' es el tenant de PRUEBA (santi
-- todavía se llama santi), así que esto NO toca el contenido bueno.
DO $$
DECLARE
  v_t uuid;
BEGIN
  SELECT id INTO v_t FROM tenants WHERE slug = 'healthyspace';
  IF v_t IS NULL THEN
    RAISE NOTICE 'No hay healthyspace de prueba; nada que borrar.';
  ELSE
    UPDATE usuarios SET membresia_activa_id = NULL WHERE tenant_id = v_t;
    DELETE FROM reservas                 WHERE tenant_id = v_t;
    DELETE FROM lista_espera             WHERE tenant_id = v_t;
    DELETE FROM notificaciones           WHERE tenant_id = v_t;
    DELETE FROM socio_notas              WHERE tenant_id = v_t;
    DELETE FROM usuario_status_historial WHERE tenant_id = v_t;
    DELETE FROM membresia_movimientos    WHERE tenant_id = v_t;
    DELETE FROM payment_events           WHERE tenant_id = v_t;
    DELETE FROM membresias               WHERE tenant_id = v_t;
    DELETE FROM clases                   WHERE tenant_id = v_t;
    DELETE FROM auth.users
    WHERE id IN (SELECT auth_id FROM usuarios WHERE tenant_id = v_t AND auth_id IS NOT NULL);
    DELETE FROM usuarios WHERE tenant_id = v_t;
    DELETE FROM tenants  WHERE id = v_t;
    RAISE NOTICE 'healthyspace de prueba eliminado.';
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2) Rename santi → healthyspace
-- ----------------------------------------------------------------------------
-- (current_user = postgres en la migración → los guardrails no la bloquean.)
UPDATE tenants
SET slug = 'healthyspace',
    nombre = 'Healthy Space'
WHERE slug = 'santi';

-- ----------------------------------------------------------------------------
-- 3) Repuntar las funciones del demo a 'healthyspace'
-- ----------------------------------------------------------------------------

-- 3a) provisionar_demo: el visitante anónimo se auto-provisiona en healthyspace.
CREATE OR REPLACE FUNCTION provisionar_demo(p_rol text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_anon boolean;
  v_demo uuid;
  v_user uuid;
  v_tier_id uuid;
  v_tier_slug text;
  v_mem uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sin sesión.';
  END IF;
  IF p_rol NOT IN ('admin', 'miembro', 'recepcionista') THEN
    RAISE EXCEPTION 'Rol de demo inválido.';
  END IF;

  SELECT is_anonymous INTO v_anon FROM auth.users WHERE id = v_uid;
  IF NOT COALESCE(v_anon, false) THEN
    RAISE EXCEPTION 'Solo el demo anónimo puede usar esta función.';
  END IF;

  SELECT id INTO v_demo FROM tenants WHERE slug = 'healthyspace';
  IF v_demo IS NULL THEN
    RAISE EXCEPTION 'healthyspace no existe.';
  END IF;

  SELECT id INTO v_user FROM usuarios WHERE auth_id = v_uid;
  IF v_user IS NULL THEN
    INSERT INTO usuarios (auth_id, tenant_id, email, nombre, rol, status)
    VALUES (v_uid, v_demo, 'demo-' || v_uid || '@demo.local', 'Visitante demo', p_rol, 'activo')
    RETURNING id INTO v_user;
  ELSE
    UPDATE usuarios SET rol = p_rol, status = 'activo', tenant_id = v_demo WHERE id = v_user;
  END IF;

  IF p_rol = 'miembro' THEN
    SELECT id, slug INTO v_tier_id, v_tier_slug
    FROM tiers WHERE tenant_id = v_demo AND activo = true
    ORDER BY precio_centavos DESC LIMIT 1;

    IF v_tier_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM membresias WHERE usuario_id = v_user AND status = 'activa') THEN
      INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_demo, v_user, v_tier_id, 'activa', now(), now() + interval '365 days')
      RETURNING id INTO v_mem;
      UPDATE usuarios SET membresia_activa_id = v_mem, membresia_tier = v_tier_slug WHERE id = v_user;
    END IF;
  END IF;
END;
$$;

COMMENT ON FUNCTION provisionar_demo(text) IS
  'Demo anónimo: da al visitante (usuario anónimo) el rol elegido dentro de healthyspace. Solo anónimos; siempre healthyspace.';

-- 3b) reset_sala_demo: limpieza nocturna de visitantes anónimos en healthyspace.
CREATE OR REPLACE FUNCTION reset_sala_demo()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_demo uuid;
  v_corte timestamptz := now() - interval '25 hours';
BEGIN
  SELECT id INTO v_demo FROM tenants WHERE slug = 'healthyspace';
  IF v_demo IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM notificaciones        WHERE tenant_id = v_demo AND creada_at  > v_corte;
  DELETE FROM lista_espera          WHERE tenant_id = v_demo AND created_at > v_corte;
  DELETE FROM membresia_movimientos WHERE tenant_id = v_demo AND created_at > v_corte;
  DELETE FROM reservas              WHERE tenant_id = v_demo AND created_at > v_corte;
  DELETE FROM membresias            WHERE tenant_id = v_demo AND created_at > v_corte;

  DELETE FROM usuarios u
  WHERE u.tenant_id = v_demo
    AND u.created_at > v_corte
    AND (u.rol = 'miembro'
         OR u.auth_id IN (SELECT id FROM auth.users WHERE is_anonymous = true));
END;
$$;

COMMENT ON FUNCTION reset_sala_demo() IS
  'Limpia visitantes anónimos del demo y su actividad transaccional (healthyspace, últimas 25h). Programada de noche vía pg_cron.';

-- 3c) Guardrails: la estructura de healthyspace es de solo lectura desde la app.
CREATE OR REPLACE FUNCTION proteger_demo_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF current_user = 'authenticated'
     AND NEW.id = (SELECT id FROM tenants WHERE slug = 'healthyspace') THEN
    RAISE EXCEPTION 'Modo demo: no se puede cambiar la configuración del gimnasio de ejemplo.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION proteger_demo_hijo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_demo uuid;
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT id INTO v_demo FROM tenants WHERE slug = 'healthyspace';
  IF COALESCE(NEW.tenant_id, OLD.tenant_id) = v_demo THEN
    RAISE EXCEPTION 'Modo demo: no se puede cambiar la configuración del gimnasio de ejemplo.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 3d) Trigger de signup: el fallback de tenant pasa a healthyspace.
CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_tenant_slug text;
  v_nombre text;
  v_telefono text;
BEGIN
  -- DEMO: los visitantes anónimos no llevan fila de usuarios automática;
  -- provisionar_demo() crea la suya con el rol/tenant elegido.
  IF COALESCE(NEW.is_anonymous, false) THEN
    RETURN NEW;
  END IF;

  -- S9: el onboarding self-service crea su propio usuario admin.
  IF COALESCE(NEW.raw_user_meta_data->>'onboarding', '') = 'true' THEN
    RETURN NEW;
  END IF;

  v_tenant_slug := COALESCE(
    NEW.raw_user_meta_data->>'tenant_slug',
    'healthyspace'
  );

  SELECT id INTO v_tenant_id FROM tenants WHERE slug = v_tenant_slug;

  IF v_tenant_id IS NULL THEN
    RAISE NOTICE 'Tenant % no existe, usando healthyspace como fallback', v_tenant_slug;
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'healthyspace';
  END IF;

  v_nombre := NEW.raw_user_meta_data->>'nombre';
  v_telefono := NEW.raw_user_meta_data->>'telefono';

  INSERT INTO usuarios (
    auth_id, tenant_id, email, nombre, telefono, rol, status
  ) VALUES (
    NEW.id,
    v_tenant_id,
    NEW.email,
    v_nombre,
    v_telefono,
    'miembro',
    'pendiente_onboarding'
  )
  ON CONFLICT (tenant_id, email) DO NOTHING;

  RETURN NEW;
END;
$$;
