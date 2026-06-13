-- ============================================================================
-- FIX #2 — "último admin": unificar el criterio de "admin activo".
-- ----------------------------------------------------------------------------
-- Tres guardas responden la MISMA pregunta ("¿es el último admin?") con tres
-- definiciones distintas de activo:
--   • count_active_admins        →  status NOT IN ('cancelado','suspendido')
--   • admin-delete-user (inline) →  status <> 'cancelado'
--   • count_admins_activos       →  status = 'activo'   ← la correcta
--
-- Las dos primeras cuentan DE MÁS (un admin 'revocado'/'pendiente_pago'/
-- 'suspendido' suma como si pudiera operar). Resultado: un tenant con 1 admin
-- 'activo' + 1 'revocado' deja eliminar/demotar al activo → queda SIN admin
-- que pueda entrar (lockout).
--
-- Definición canónica: solo 'activo' cuenta (es el único que puede loguear y
-- gestionar). Acá alineamos count_active_admins a 'activo'. El inline de
-- admin-delete-user se corrige en su index.ts (mismo commit del fix).
--
-- ADEMÁS — bug latente destapado por el test: la feature "Revocar acceso" del
-- Equipo escribe status='revocado' (crudHelpers.revokeTeamMember) y Equipo.tsx
-- filtra por ese valor, pero el CHECK de usuarios NUNCA incluyó 'revocado' →
-- revocar tiraba CHECK violation (la feature estaba rota a nivel DB). Sumamos
-- 'revocado' al CHECK acá (idempotente). El login de un revocado se gatea en
-- los guards aparte (pendiente, fuera de esta migración).
-- ============================================================================

-- Habilita el status 'revocado' (soft-revoke de staff, preserva auditoría).
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_status_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_status_check
  CHECK (status IN ('pendiente_onboarding', 'pendiente_pago', 'activo',
                    'suspendido', 'cancelado', 'revocado'));

CREATE OR REPLACE FUNCTION count_active_admins(p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COUNT(*)::integer FROM usuarios
  WHERE tenant_id = p_tenant_id
    AND rol = 'admin'
    AND status = 'activo';
$$;

GRANT EXECUTE ON FUNCTION count_active_admins(uuid) TO authenticated;

COMMENT ON FUNCTION count_active_admins IS
  'Cuenta admins ACTIVOS (status=activo) del tenant. Guarda anti "último admin" usada por admin-update-role y admin-delete-user. Criterio unificado con count_admins_activos (fix #2).';

-- ============================================================================
-- TEST — count_active_admins cuenta SOLO status='activo'.
-- Crea 1 admin activo + 1 admin revocado en un tenant real; el contador debe
-- subir en 1 (no en 2). Savepoint + centinela; no deja datos.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid; v_slug text;
  v_auth_a uuid := gen_random_uuid();
  v_auth_b uuid := gen_random_uuid();
  v_base int; v_post int;
BEGIN
  SELECT id, slug INTO v_tenant, v_slug FROM tenants LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay tenants (el fix igual quedó aplicado).';
    RETURN;
  END IF;

  SELECT count_active_admins(v_tenant) INTO v_base;

  BEGIN  -- subtransacción reversible
    -- Dos usuarios de prueba (el trigger los crea miembro del tenant).
    INSERT INTO auth.users (instance_id, id, aud, role, email,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES
      ('00000000-0000-0000-0000-000000000000', v_auth_a, 'authenticated', 'authenticated',
       'fix-adm-a-'||substr(v_auth_a::text,1,8)||'@test.local',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin Activo'), now(), now()),
      ('00000000-0000-0000-0000-000000000000', v_auth_b, 'authenticated', 'authenticated',
       'fix-adm-b-'||substr(v_auth_b::text,1,8)||'@test.local',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin Revocado'), now(), now());

    -- A = admin activo, B = admin revocado.
    UPDATE usuarios SET rol = 'admin', status = 'activo'   WHERE auth_id = v_auth_a;
    UPDATE usuarios SET rol = 'admin', status = 'revocado' WHERE auth_id = v_auth_b;

    SELECT count_active_admins(v_tenant) INTO v_post;

    IF v_post <> v_base + 1 THEN
      RAISE EXCEPTION 'TEST FALLO: count_active_admins contó el revocado (base=% post=%, esperado %).',
        v_base, v_post, v_base + 1;
    END IF;

    RAISE EXCEPTION 'ROLLBACK_FIX_ADM';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_FIX_ADM' THEN NULL;
    ELSE RAISE; END IF;
  END;

  RAISE NOTICE 'TEST OK: count_active_admins cuenta solo status=activo (revocado NO suma). Revertido.';
END $$;
