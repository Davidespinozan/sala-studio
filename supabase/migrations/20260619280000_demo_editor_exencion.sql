-- ============================================================================
-- DEMO: excepción de edición para el dueño (s@hotmail.com)
-- ----------------------------------------------------------------------------
-- Los guardrails (proteger_demo_tenant / proteger_demo_hijo) hacen que la
-- estructura de healthyspace sea de solo lectura desde la app para CUALQUIER
-- usuario `authenticated` — por eso el contenido del demo venía por migración.
--
-- Esta migración abre una sola excepción: el correo s@hotmail.com (el dueño)
-- SÍ puede editar el demo desde el admin, igual que un gym normal. El resto de
-- visitantes (cuentas demo anónimas, etc.) sigue bloqueado. Las migraciones
-- (current_user = postgres) y Netlify (service_role) siguen pasando como antes.
--
-- El correo se lee del JWT de la sesión (auth.jwt() ->> 'email'), no de la fila
-- usuarios, para que ni siquiera dependa de RLS.
-- ============================================================================

-- Tabla `tenants` (la fila ES el tenant → se chequea por id).
CREATE OR REPLACE FUNCTION proteger_demo_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF current_user = 'authenticated'
     AND lower(coalesce(auth.jwt() ->> 'email', '')) <> 's@hotmail.com'
     AND NEW.id = (SELECT id FROM tenants WHERE slug = 'healthyspace') THEN
    RAISE EXCEPTION 'Modo demo: no se puede cambiar la configuración del gimnasio de ejemplo.';
  END IF;
  RETURN NEW;
END;
$$;

-- Tablas hijas (tienen tenant_id).
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
  IF lower(coalesce(auth.jwt() ->> 'email', '')) = 's@hotmail.com' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT id INTO v_demo FROM tenants WHERE slug = 'healthyspace';
  IF COALESCE(NEW.tenant_id, OLD.tenant_id) = v_demo THEN
    RAISE EXCEPTION 'Modo demo: no se puede cambiar la configuración del gimnasio de ejemplo.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ----------------------------------------------------------------------------
-- Diagnóstico: deja claro en qué tenant/rol está s@hotmail.com hoy.
-- Para EDITAR el demo desde el admin, esa cuenta debe ser admin de healthyspace
-- (tenant_id = healthyspace, rol = 'admin'). Si el NOTICE muestra otra cosa,
-- avisame y lo ajustamos en una migración aparte (no lo toco automáticamente
-- por si es admin de un gym real).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_info text;
BEGIN
  SELECT string_agg(
           format('usuarios.id=%s rol=%s tenant=%s', u.id, u.rol, t.slug),
           ' | '
         )
  INTO v_info
  FROM usuarios u
  LEFT JOIN tenants t ON t.id = u.tenant_id
  WHERE lower(u.email) = 's@hotmail.com';

  IF v_info IS NULL THEN
    RAISE NOTICE '[demo-editor] s@hotmail.com NO tiene fila en usuarios. Para editar el demo necesita ser admin de healthyspace.';
  ELSE
    RAISE NOTICE '[demo-editor] s@hotmail.com -> %', v_info;
  END IF;
END;
$$;
