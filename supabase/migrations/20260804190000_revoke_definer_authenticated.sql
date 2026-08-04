-- ── Cerrar funciones SECURITY DEFINER que seguían llamables por `authenticated` ──
-- Causa raíz: `REVOKE ... FROM PUBLIC` NO remueve el EXECUTE que Supabase concede
-- por default a `authenticated`. Estas funciones (trigger/cron/internas) quedaron
-- llamables directo por cualquier usuario logueado de cualquier tenant, y su cuerpo
-- no revalida el tenant → manipulación de estado entre gyms (notificaciones/push
-- falsas al staff de otro tenant, materializar su calendario, promover su lista de
-- espera y reembolsar créditos ajenos, contaminar su ledger, crear tenants sin auth).
--
-- Fix: REVOKE de PUBLIC + authenticated + anon, y GRANT solo a service_role.
-- Se hace por NOMBRE (todas las sobrecargas), con regprocedure para firmas exactas,
-- así no depende de la firma y no rompe si una función no existe.

DO $$
DECLARE
  r record;
  nombres text[] := ARRAY[
    'crear_tenant_onboarding',        -- H2: anon podía provisionar tenants+admin
    'notificar_staff',                -- H4: push/aviso falso al staff de otro tenant
    'generar_clases_recurrentes',     -- H4: materializar el calendario de otro tenant
    'promover_siguiente_en_espera',   -- H4: forzar promociones/reembolsos ajenos
    '_promover_entrada',              -- H4: helper interno de la anterior
    '_registrar_no_show_ledger',      -- H4: contaminar el ledger de otro tenant
    'expirar_listas_espera_vencidas', -- H4: cron, forzaba expiraciones globales
    'avisar_membresias_por_vencer',   -- M4: cron
    '_estado_membresia_checkin',      -- M4: oráculo de estado por UUID
    '_guard_membresia_checkin'        -- M4: helper interno de check-in
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY(nombres)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, authenticated, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- Helper de desarrollo muerto (hardcodeado al slug borrado 'sala-demo'); su propio
-- comentario decía "eliminar antes de producción".
DROP FUNCTION IF EXISTS dev_crear_recepcionista(text, text);

-- ── Self-test (devuelve tabla) ───────────────────────────────────────────────
-- authenticated_puede y anon_puede deben ser FALSE en todas.
SELECT p.proname AS funcion,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_puede,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_puede,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role_puede
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = ANY(ARRAY[
  'crear_tenant_onboarding','notificar_staff','generar_clases_recurrentes',
  'promover_siguiente_en_espera','_promover_entrada','_registrar_no_show_ledger',
  'expirar_listas_espera_vencidas','avisar_membresias_por_vencer',
  '_estado_membresia_checkin','_guard_membresia_checkin'])
ORDER BY p.proname;
