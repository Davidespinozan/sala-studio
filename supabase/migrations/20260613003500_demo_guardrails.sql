-- ============================================================================
-- Guardrails del DEMO: la estructura de sala-demo es de solo lectura DESDE LA APP.
-- ----------------------------------------------------------------------------
-- El visitante (cuenta demo, rol authenticated) puede operar lo transaccional
-- (reservas, socios, check-in) pero NO puede desfigurar el "cascarón" que ven
-- otros visitantes: marca, landing, planes, salas, instructores, sedes y la
-- parrilla recurrente. Las migraciones (postgres) y Netlify (service_role)
-- siguen pudiendo — solo bloqueamos a current_user='authenticated' sobre
-- sala-demo. Patrón igual al de trg_proteger_usuarios.
-- ============================================================================

-- Tabla `tenants` (la fila ES el tenant → se chequea por id).
CREATE OR REPLACE FUNCTION proteger_demo_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF current_user = 'authenticated'
     AND NEW.id = (SELECT id FROM tenants WHERE slug = 'sala-demo') THEN
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
  SELECT id INTO v_demo FROM tenants WHERE slug = 'sala-demo';
  IF COALESCE(NEW.tenant_id, OLD.tenant_id) = v_demo THEN
    RAISE EXCEPTION 'Modo demo: no se puede cambiar la configuración del gimnasio de ejemplo.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_demo_tenants ON tenants;
CREATE TRIGGER trg_demo_tenants
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION proteger_demo_tenant();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tiers', 'recursos', 'instructores', 'sucursales', 'horarios_recurrentes']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_demo_%1$s ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_demo_%1$s BEFORE INSERT OR UPDATE OR DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION proteger_demo_hijo()',
      t
    );
  END LOOP;
END;
$$;
