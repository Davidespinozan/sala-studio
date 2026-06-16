-- ============================================================================
-- Cuenta DEMO de dueño (Fase 1 del "Probar demo").
-- ----------------------------------------------------------------------------
-- Antes de correr esto: creá el usuario de auth `demo@salastudio.app` desde el
-- dashboard de Supabase (Authentication → Add user) con una contraseña, SIN
-- crear ninguna fila en `usuarios` (el dashboard no la crea). Esta migración la
-- crea y la vincula como ADMIN de sala-demo.
--
-- Luego, en Netlify, seteá:
--   VITE_DEMO_EMAIL = demo@salastudio.app
--   VITE_DEMO_PASSWORD = <la contraseña que pusiste>
-- Sin esas env, el botón "Probar demo" no aparece (no se activa nada).
--
-- Es seguro: la RLS encierra esta cuenta en sala-demo (no puede tocar otro gym).
-- Idempotente.
-- ============================================================================

INSERT INTO usuarios (auth_id, tenant_id, email, nombre, rol, status)
SELECT au.id, t.id, au.email, 'Demo · dueño', 'admin', 'activo'
FROM auth.users au
CROSS JOIN (SELECT id FROM tenants WHERE slug = 'sala-demo') t
WHERE lower(au.email) = 'demo@salastudio.app'
ON CONFLICT (tenant_id, email) DO UPDATE
  SET rol = 'admin',
      status = 'activo',
      auth_id = EXCLUDED.auth_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM usuarios u
    JOIN tenants t ON t.id = u.tenant_id
    WHERE t.slug = 'sala-demo' AND lower(u.email) = 'demo@salastudio.app' AND u.rol = 'admin'
  ) THEN
    RAISE NOTICE 'OJO: no se vinculó la cuenta demo. ¿Creaste el auth user demo@salastudio.app en el dashboard ANTES de correr esto?';
  ELSE
    RAISE NOTICE 'Cuenta demo (dueño) vinculada como admin de sala-demo. Falta setear VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD en Netlify.';
  END IF;
END $$;
