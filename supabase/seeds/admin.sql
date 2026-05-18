-- Primer admin de SALA Studio (tenant sala-demo)
--
-- Cómo usar:
-- 1. En Supabase dashboard → Authentication → Users → Add user → "Create new user":
--    - Email: <tu email>
--    - Password: <generar uno fuerte>
--    - Auto-confirm: ✅ marcar
-- 2. Copiá el UUID del user recién creado.
-- 3. Reemplazá <AUTH_USER_UUID>, <NOMBRE> y <EMAIL> abajo, y corré el SQL en
--    Supabase dashboard → SQL Editor.

WITH tenant AS (
  SELECT id FROM tenants WHERE slug = 'sala-demo'
)
INSERT INTO usuarios (
  auth_id,
  tenant_id,
  nombre,
  email,
  rol,
  status,
  invitado
)
SELECT
  '<AUTH_USER_UUID>'::uuid,
  tenant.id,
  '<NOMBRE>',
  '<EMAIL>',
  'admin',
  'activo',
  false
FROM tenant;
