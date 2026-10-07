-- ════════════════════════════════════════════════════════════════════════════
-- ENDURECER ACL · anon/PUBLIC en RPCs autenticadas (AUTHORIZATION SURFACE)
-- ────────────────────────────────────────────────────────────────────────────
-- Causa raíz (confirmada en código y en catálogo vivo de producción):
--   Supabase concede EXECUTE a `anon` y `authenticated` por default al crear
--   una función, INDEPENDIENTE de PUBLIC. Un `REVOKE ... FROM PUBLIC` solo NO
--   remueve ese grant directo. Varias funciones de esta app nunca recibieron
--   el REVOKE explícito de `anon` (algunas ni siquiera de PUBLIC), y la
--   consulta en vivo contra producción (pg_proc + has_function_privilege)
--   confirmó que siguen siendo ejecutables por `anon` hoy.
--
-- Hallazgos (auditoría READ-ONLY previa, evidencia en vivo):
--   A) reset_sala_demo() — anon ejecutable, CERO guard en el cuerpo. Cualquiera
--      sin sesión podía disparar el borrado (25h) del tenant demo 'healthyspace'
--      a demanda, en vez de solo por el cron nocturno. Revoca de PUBLIC, anon Y
--      authenticated — nadie del cliente debe poder llamarla nunca; el cron la
--      invoca como su dueño, sin necesidad de ningún GRANT.
--   B) count_active_admins(uuid) / count_admins_activos(uuid) — anon ejecutable.
--      El cuerpo usa COALESCE(get_my_tenant_id(), p_tenant_id): para
--      `authenticated` esto es seguro (siempre usa SU tenant), pero anon
--      también resuelve get_my_tenant_id() a NULL → el fallback al parámetro
--      se activa igual, revelando el conteo de admins de CUALQUIER tenant con
--      solo adivinar su UUID. Se revoca de PUBLIC y anon; `authenticated` se
--      preserva (su camino ya es seguro) y `service_role` (Netlify
--      admin-update-role) no se toca — su grant es independiente.
--   C) Higiene de ACL — 29 RPCs más, todas mutando/leyendo con guard de rol
--      (is_recepcionista()/is_admin()/dueño) ya correcto en el cuerpo, SIN
--      bypass demostrado, pero con ACL más ancha de lo necesario (anon nunca
--      revocado). Se revoca de PUBLIC y anon; `authenticated` se preserva en
--      todos los casos (es el rol de transporte correcto para socio/
--      recepción/admin — la autorización real vive en el cuerpo).
--
-- Mecanismo: igual que 20260804190000_revoke_definer_authenticated.sql —
-- revoca por NOMBRE vía pg_proc::regprocedure (no depende de la firma exacta,
-- a prueba de sobrecargas; confirmado que ninguno de estos nombres tiene hoy
-- una sobrecarga viva no intencional).
--
-- Fuera de alcance a propósito (backlog separado, NO tocado acá):
--   _fn_llama, recepcion_ajustar_creditos, generar_codigo_activacion
--   (código muerto/huérfano), invitados_disponibles (reescritura defensiva de
--   su primer guard), ALTER DEFAULT PRIVILEGES, investigación histórica de
--   crear_tenant_onboarding. Ningún comportamiento económico/de negocio
--   cambia en esta migración.
-- ════════════════════════════════════════════════════════════════════════════

-- ── A) reset_sala_demo: nadie del cliente debe poder invocarla ─────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reset_sala_demo'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $$;

-- ── B) Conteo de admins: cierra el oráculo cross-tenant para anon ──────────
-- authenticated se preserva (su camino ya resuelve SIEMPRE su propio tenant).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(ARRAY['count_active_admins', 'count_admins_activos'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
  END LOOP;
END $$;

-- ── C) Higiene de ACL: conjunto confirmado en vivo, body ya fail-closed ────
-- authenticated se preserva en TODOS los casos (rol de transporte correcto;
-- la autorización real es el guard de rol/dueño dentro de cada función).
DO $$
DECLARE
  r record;
  nombres text[] := ARRAY[
    'anotar_lista_espera',
    'anotar_lista_espera_virtual',
    'cambiar_lugar_reserva',
    'cancelar_clase',
    'cancelar_reserva_admin',
    'cancelar_reserva_atomic',
    'check_in_atomic',
    'check_in_manual_atomic',
    'editar_clase_override',
    'enviar_aviso_socio',
    'expandir_clases',
    'invitados_disponibles',
    'materializar_clase',
    'mi_posicion_lista_espera',
    'mis_listas_espera',
    'promover_manual_lista_espera',
    'recepcion_agregar_nota',
    'recepcion_bloquear_socio',
    'recepcion_cancelar_membresia',
    'recepcion_cancelar_reserva',
    'recepcion_congelar_membresia',
    'recepcion_corregir_checkin',
    'recepcion_crear_reserva',
    'recepcion_desbloquear_socio',
    'recepcion_editar_contacto',
    'recepcion_marcar_no_show',
    'recepcion_reactivar_membresia',
    'recepcion_recargar_creditos',
    'salir_lista_espera',
    'timezone_de_sucursal',
    'tenant_abandonado'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY(nombres)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
  END LOOP;
END $$;
