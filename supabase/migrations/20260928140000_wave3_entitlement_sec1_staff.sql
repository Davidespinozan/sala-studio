-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Envuelto en BEGIN/COMMIT: todo-o-nada. Si cualquier statement (incl. un
-- self-test) falla, se revierte la migración entera.
-- ============================================================================
BEGIN;

-- ============================================================================
-- WAVE 3 (parcial) — Entitlement / derechos de acceso
-- W3-01 (RC-07/SEC-1): un miembro no puede auto-otorgarse entitlement.
-- W3-02 (RC-08): staff revocado no puede hacer check-in con una sesión vieja.
-- W3-03 queda EN HOLD (no se toca: reservas futuras, capacidad, congelar,
--       expiración, asientos de invitado, créditos, ciclo de membresía).
-- W1 (business_operations) y W2 (locks/FOR UPDATE) NO se tocan.
-- ----------------------------------------------------------------------------
-- W3-01: `usuarios_update_self` (RLS) deja al miembro escribir CUALQUIER columna
--   de su propia fila; `trg_proteger_usuarios` (20260613002500) solo protegía
--   rol/status/tenant_id. Así un miembro podía PATCH por PostgREST su propio
--   `bloqueado_hasta` (quitarse una sanción de no-show) y `membresia_tier`
--   (auto-upgrade → burlar TIER_NO_PERMITIDO). Se extiende el MISMO trigger para
--   proteger también membresia_tier / membresia_activa_id / bloqueado_hasta /
--   inscripcion_pagada_at. Los RPC SECURITY DEFINER (owner=postgres) y el
--   service_role NO son 'authenticated'/'anon' → se saltan el check (igual que
--   hoy con rol/status). Los admins (is_admin()) siguen pudiendo. Los edits de
--   perfil (nombre/teléfono/avatar/…) no tocan estas columnas → siguen libres.
-- W3-02: check_in_atomic / check_in_manual_atomic autorizaban por get_my_rol()
--   (que NO filtra status). Se cambia a leer rol+status del caller y exigir
--   status='activo' (mismo patrón que vender_productos). El resto del cuerpo
--   —incluido el FOR UPDATE de W2 y los guards— queda VERBATIM.
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- W3-01 · trg_proteger_usuarios: proteger también los campos de entitlement.
--   (verbatim de 20260613002500 + columnas nuevas en v_priv_change; C3 intacto)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION trg_proteger_usuarios()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY INVOKER (default): necesitamos el current_user REAL del ejecutor.
AS $$
DECLARE
  v_priv_change boolean;
BEGIN
  v_priv_change :=
       NEW.rol       IS DISTINCT FROM OLD.rol
    OR NEW.status    IS DISTINCT FROM OLD.status
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    -- W3-01: entitlement/sanción/enrolamiento — solo admin/servidor los cambia.
    OR NEW.membresia_tier      IS DISTINCT FROM OLD.membresia_tier
    OR NEW.membresia_activa_id IS DISTINCT FROM OLD.membresia_activa_id
    OR NEW.bloqueado_hasta     IS DISTINCT FROM OLD.bloqueado_hasta
    OR NEW.inscripcion_pagada_at IS DISTINCT FROM OLD.inscripcion_pagada_at;

  -- Updates de perfil (nombre/teléfono/avatar/etc.): nada que proteger.
  IF NOT v_priv_change THEN
    RETURN NEW;
  END IF;

  -- C1 (+W3-01) — un end-user autenticado que NO es admin activo no puede tocar
  -- rol/status/tenant NI su propio plan/sanción/enrolamiento (ni en su propia
  -- fila). Los flujos legítimos (service_role de las Netlify functions, RPCs
  -- SECURITY DEFINER de owner postgres) corren con otro current_user y se saltan
  -- este check.
  IF current_user IN ('authenticated', 'anon') AND NOT is_admin() THEN
    RAISE EXCEPTION
      'PRIVILEGIO_DENEGADO: no podés modificar rol, estado, tenant, plan, sanción ni enrolamiento de un usuario.';
  END IF;

  -- C3 — backstop absoluto: nunca dejar el tenant sin ningún admin activo.
  IF OLD.rol = 'admin' AND OLD.status = 'activo'
     AND (NEW.rol IS DISTINCT FROM 'admin' OR NEW.status IS DISTINCT FROM 'activo') THEN
    IF count_admins_activos(OLD.tenant_id) <= 1 THEN
      RAISE EXCEPTION
        'ULTIMO_ADMIN: no podés dejar el tenant sin ningún admin activo. Asigná otro admin primero.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_proteger_usuarios() IS
  'BEFORE UPDATE usuarios: C1 bloquea cambios de rol/status/tenant Y de entitlement (membresia_tier/membresia_activa_id/bloqueado_hasta/inscripcion_pagada_at) por end-users no-admin (W3-01/SEC-1); C3 impide dejar el tenant sin admin activo.';
-- El trigger usuarios_proteger_iam sigue apuntando a esta función (CREATE OR REPLACE).

-- ════════════════════════════════════════════════════════════════════════════
-- W3-02 · check-in status-aware. Cuerpo VERBATIM de W2 (20260928130000) con la
--   única diferencia: la autorización lee rol+status del caller y exige
--   status='activo' en vez de confiar en get_my_rol() (status-blind).
-- ════════════════════════════════════════════════════════════════════════════

-- 1) QR
CREATE OR REPLACE FUNCTION check_in_atomic(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_caller_status text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_min integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  -- W3-02: autorización status-aware. El rol cacheado del helper NO filtra status
  -- → un staff revocado con JWT vivo pasaba. Leemos rol+status del caller y
  -- exigimos status='activo'.
  SELECT rol, status INTO v_rol, v_caller_status FROM usuarios WHERE id = v_user_id;
  IF v_rol IS NULL OR v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;
  IF v_caller_status IS DISTINCT FROM 'activo' THEN
    RAISE EXCEPTION 'CUENTA_INACTIVA: tu acceso fue revocado o desactivado';
  END IF;

  -- W2-03: FOR UPDATE serializa el check-in de ESTA reserva.
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  PERFORM _guard_sucursal_staff(v_reserva.recurso_id);

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  PERFORM _guard_membresia_checkin(v_reserva.usuario_id);

  v_ventana_min := ventana_check_in_min(v_tenant_id);
  v_ventana_inicio := v_reserva.slot_inicio - (v_ventana_min || ' minutes')::interval;
  v_ventana_fin := v_reserva.slot_fin + (v_ventana_min * 2 || ' minutes')::interval;

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in abre % min antes (a las %)',
      v_ventana_min, to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'DEMASIADO_TARDE: El check-in cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'qr'
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  IF v_rol IN ('recepcionista', 'admin') THEN
    PERFORM _audrec_log(
      'checkin.qr', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
      format('Check-in QR de %s', to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI')),
      jsonb_build_object('method', 'qr')
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    'membresia_estado', _estado_membresia_checkin(v_reserva.usuario_id),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

-- 2) Manual
CREATE OR REPLACE FUNCTION check_in_manual_atomic(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_caller_status text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_min integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  -- W3-02: autorización status-aware (ver check_in_atomic).
  SELECT rol, status INTO v_rol, v_caller_status FROM usuarios WHERE id = v_user_id;
  IF v_rol IS NULL OR v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;
  IF v_caller_status IS DISTINCT FROM 'activo' THEN
    RAISE EXCEPTION 'CUENTA_INACTIVA: tu acceso fue revocado o desactivado';
  END IF;

  -- W2-03: FOR UPDATE (ver check_in_atomic).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  PERFORM _guard_sucursal_staff(v_reserva.recurso_id);

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in';
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Reserva cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Reserva marcada como inasistencia';
  END IF;

  -- OJO: acá NO bloqueamos por membresía (política: recepción decide).

  v_ventana_min := ventana_check_in_min(v_tenant_id);
  v_ventana_inicio := v_reserva.slot_inicio - (v_ventana_min * 2 || ' minutes')::interval;
  v_ventana_fin := v_reserva.slot_fin + (v_ventana_min * 4 || ' minutes')::interval;

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in manual abre % min antes (a las %)',
      v_ventana_min * 2, to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'DEMASIADO_TARDE: El check-in manual cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'manual',
      notas = COALESCE(notas, '') ||
              CASE WHEN p_motivo IS NOT NULL
                   THEN E'\n[Check-in manual: ' || p_motivo || ']'
                   ELSE E'\n[Check-in manual]'
              END
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  IF v_rol IN ('recepcionista', 'admin') THEN
    PERFORM _audrec_log(
      'checkin.manual', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
      format('Check-in manual de %s.%s',
             to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
             CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                  THEN ' Motivo: ' || p_motivo ELSE '' END),
      jsonb_build_object('method', 'manual', 'motivo', p_motivo)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    'membresia_estado', _estado_membresia_checkin(v_reserva.usuario_id),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_in_atomic(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION check_in_manual_atomic(uuid, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST DE CONTRATO (estructural) — no se perdió nada en la recreación.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_src text; v_falta text[] := ARRAY[]::text[];
BEGIN
  -- W3-01: el trigger protege los 4 campos de entitlement.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'trg_proteger_usuarios';
  IF position('membresia_tier' IN v_src) = 0 THEN v_falta := array_append(v_falta,'trigger:membresia_tier'); END IF;
  IF position('membresia_activa_id' IN v_src) = 0 THEN v_falta := array_append(v_falta,'trigger:membresia_activa_id'); END IF;
  IF position('bloqueado_hasta' IN v_src) = 0 THEN v_falta := array_append(v_falta,'trigger:bloqueado_hasta'); END IF;
  IF position('inscripcion_pagada_at' IN v_src) = 0 THEN v_falta := array_append(v_falta,'trigger:inscripcion_pagada_at'); END IF;
  IF position('ULTIMO_ADMIN' IN v_src) = 0 THEN v_falta := array_append(v_falta,'trigger:C3_ultimo_admin_perdido'); END IF;

  -- W3-02: check-in status-aware + W2 FOR UPDATE + guards preservados; sin get_my_rol.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'check_in_atomic';
  IF position('CUENTA_INACTIVA' IN v_src) = 0 THEN v_falta := array_append(v_falta,'qr:status_check'); END IF;
  IF position('get_my_rol' IN v_src) > 0 THEN v_falta := array_append(v_falta,'qr:aun_usa_get_my_rol'); END IF;
  IF position('FOR UPDATE' IN v_src) = 0 THEN v_falta := array_append(v_falta,'qr:FOR_UPDATE_perdido'); END IF;
  IF position('_guard_membresia_checkin' IN v_src) = 0 THEN v_falta := array_append(v_falta,'qr:guard_membresia_perdido'); END IF;
  IF position('_guard_sucursal_staff' IN v_src) = 0 THEN v_falta := array_append(v_falta,'qr:guard_sucursal_perdido'); END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'check_in_manual_atomic';
  IF position('CUENTA_INACTIVA' IN v_src) = 0 THEN v_falta := array_append(v_falta,'manual:status_check'); END IF;
  IF position('get_my_rol' IN v_src) > 0 THEN v_falta := array_append(v_falta,'manual:aun_usa_get_my_rol'); END IF;
  IF position('FOR UPDATE' IN v_src) = 0 THEN v_falta := array_append(v_falta,'manual:FOR_UPDATE_perdido'); END IF;
  IF position('_guard_membresia_checkin' IN v_src) > 0 THEN v_falta := array_append(v_falta,'manual:NO_debe_bloquear_membresia'); END IF;

  IF cardinality(v_falta) > 0 THEN
    RAISE EXCEPTION 'W3_CONTRATO_ROTO: %', array_to_string(v_falta, ', ');
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST FUNCIONAL W3-01 (SEC-1) — subtransacción reversible con sentinela.
--   Un miembro autenticado NO puede auto-cambiar entitlement; sí su nombre;
--   el owner (RPC/admin) sí puede cambiar el entitlement.
-- ════════════════════════════════════════════════════════════════════════════
DO $outer$
DECLARE
  v_tenant uuid; v_auth_mem uuid := gen_random_uuid(); v_id_mem uuid;
  v_slug text := 'zz-w3sec1-' || substr(md5(random()::text),1,6);
  v_ok boolean;
BEGIN
  BEGIN
    INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'W3 SEC1','gym_libre','activo') RETURNING id INTO v_tenant;
    INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000',v_auth_mem,'authenticated','authenticated',
            v_slug||'-m@test.local','{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug',v_slug,'nombre','Miembro W3'),now(),now());
    UPDATE usuarios SET status='activo' WHERE auth_id=v_auth_mem RETURNING id INTO v_id_mem;
    -- El miembro arranca CON una sanción activa: así el intento de auto-desbloqueo
    -- (bloqueado_hasta future→NULL) es un cambio REAL que el trigger debe frenar.
    -- (Sin esto, NULL→NULL no es DISTINCT y el trigger deja pasar el no-op.)
    UPDATE usuarios SET bloqueado_hasta = now() + interval '7 days' WHERE id = v_id_mem;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_mem)::text, true);

    -- (a) membresia_tier → PRIVILEGIO_DENEGADO
    v_ok:=false;
    BEGIN SET LOCAL ROLE authenticated;
      UPDATE usuarios SET membresia_tier='premium-hack' WHERE id=v_id_mem;
    EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'PRIVILEGIO_DENEGADO%'; END;
    RESET ROLE;
    IF NOT v_ok THEN RAISE EXCEPTION 'W3-01 FALLO: miembro pudo auto-cambiar membresia_tier'; END IF;

    -- (b) bloqueado_hasta → PRIVILEGIO_DENEGADO (auto-quitarse sanción)
    v_ok:=false;
    BEGIN SET LOCAL ROLE authenticated;
      UPDATE usuarios SET bloqueado_hasta=NULL WHERE id=v_id_mem;
    EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'PRIVILEGIO_DENEGADO%'; END;
    RESET ROLE;
    IF NOT v_ok THEN RAISE EXCEPTION 'W3-01 FALLO: miembro pudo auto-cambiar bloqueado_hasta'; END IF;

    -- (c) membresia_activa_id → PRIVILEGIO_DENEGADO
    v_ok:=false;
    BEGIN SET LOCAL ROLE authenticated;
      UPDATE usuarios SET membresia_activa_id=gen_random_uuid() WHERE id=v_id_mem;
    EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'PRIVILEGIO_DENEGADO%'; END;
    RESET ROLE;
    IF NOT v_ok THEN RAISE EXCEPTION 'W3-01 FALLO: miembro pudo auto-cambiar membresia_activa_id'; END IF;

    -- (d) inscripcion_pagada_at → PRIVILEGIO_DENEGADO
    v_ok:=false;
    BEGIN SET LOCAL ROLE authenticated;
      UPDATE usuarios SET inscripcion_pagada_at=now() WHERE id=v_id_mem;
    EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'PRIVILEGIO_DENEGADO%'; END;
    RESET ROLE;
    IF NOT v_ok THEN RAISE EXCEPTION 'W3-01 FALLO: miembro pudo auto-cambiar inscripcion_pagada_at'; END IF;

    -- (e) nombre (perfil) → SÍ permitido
    v_ok:=false;
    BEGIN SET LOCAL ROLE authenticated;
      UPDATE usuarios SET nombre='Nombre Nuevo' WHERE id=v_id_mem;
      v_ok:=true;
    EXCEPTION WHEN raise_exception THEN v_ok:=false; END;
    RESET ROLE;
    IF NOT v_ok THEN RAISE EXCEPTION 'W3-01 FALLO: se bloqueó un edit legítimo de perfil (nombre)'; END IF;

    PERFORM set_config('request.jwt.claims','',true);

    -- (f) owner (RPC/admin path) SÍ puede cambiar el entitlement (current_user=postgres).
    UPDATE usuarios SET membresia_tier='mensual', bloqueado_hasta=NULL WHERE id=v_id_mem;

    RAISE EXCEPTION 'ROLLBACK_W3_SEC1';
  EXCEPTION WHEN raise_exception THEN
    RESET ROLE;
    PERFORM set_config('request.jwt.claims','',true);
    IF SQLERRM = 'ROLLBACK_W3_SEC1' THEN NULL; ELSE RAISE; END IF;
  END;
END;
$outer$;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST FUNCIONAL W3-02 (RC-08) — staff revocado no puede check-in.
-- ════════════════════════════════════════════════════════════════════════════
DO $outer$
DECLARE
  v_tenant uuid; v_auth_adm uuid := gen_random_uuid(); v_auth_rec uuid := gen_random_uuid();
  v_id_adm uuid; v_id_rec uuid; v_socio uuid; v_suc uuid; v_sala uuid; v_clase uuid; v_r1 uuid; v_r2 uuid;
  v_slug text := 'zz-w3rc08-' || substr(md5(random()::text),1,6);
  v_now timestamptz := now(); v_ok boolean; v_res jsonb;
BEGIN
  BEGIN
    INSERT INTO tenants (slug,nombre,vertical,status) VALUES (v_slug,'W3 RC08','gym_libre','activo') RETURNING id INTO v_tenant;
    INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000000000',v_auth_adm,'authenticated','authenticated',v_slug||'-a@test.local','{"provider":"email","providers":["email"]}'::jsonb,jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),now(),now()),
      ('00000000-0000-0000-0000-000000000000',v_auth_rec,'authenticated','authenticated',v_slug||'-r@test.local','{"provider":"email","providers":["email"]}'::jsonb,jsonb_build_object('tenant_slug',v_slug,'nombre','Recep'),now(),now());
    UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth_adm RETURNING id INTO v_id_adm;
    UPDATE usuarios SET rol='recepcionista', status='activo' WHERE auth_id=v_auth_rec RETURNING id INTO v_id_rec;
    INSERT INTO sucursales (tenant_id,nombre,timezone,activa,orden) VALUES (v_tenant,'Sede','America/Mexico_City',true,0) RETURNING id INTO v_suc;
    INSERT INTO recursos (tenant_id,sucursal_id,slug,nombre,tipo,cupos,cupo_max_default,activo) VALUES (v_tenant,v_suc,'sala-1','Sala 1','sala_grupal',10,10,true) RETURNING id INTO v_sala;
    INSERT INTO clases (tenant_id,sucursal_id,recurso_id,fecha,hora_inicio,duracion_minutos,cupo_max,status,nombre)
      VALUES (v_tenant,v_suc,v_sala,(v_now AT TIME ZONE 'UTC')::date,(v_now AT TIME ZONE 'UTC')::time,60,10,'programada','Clase W3') RETURNING id INTO v_clase;
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-s@x.dev','Socio','miembro','activo') RETURNING id INTO v_socio;
    -- dos reservas confirmadas (una para el caso activo, otra para el revocado)
    INSERT INTO reservas (tenant_id,recurso_id,usuario_id,clase_id,slot_inicio,slot_fin,duracion_min,invitados_count,status,folio)
      VALUES (v_tenant,v_sala,v_socio,v_clase,v_now,v_now+interval '60 min',60,0,'confirmada','SAL-W3A') RETURNING id INTO v_r1;
    INSERT INTO reservas (tenant_id,recurso_id,usuario_id,clase_id,slot_inicio,slot_fin,duracion_min,invitados_count,status,folio)
      VALUES (v_tenant,v_sala,v_socio,v_clase,v_now,v_now+interval '60 min',60,0,'confirmada','SAL-W3B') RETURNING id INTO v_r2;

    -- (a) recepcionista ACTIVO → check-in manual OK
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_rec)::text, true);
    v_res := check_in_manual_atomic(v_r1, 'activo');
    IF NOT (v_res->>'success')::boolean THEN RAISE EXCEPTION 'W3-02 FALLO: staff activo no pudo check-in'; END IF;

    -- (b) revocar al recepcionista → check-in DENEGADO con la sesión (JWT) vieja
    PERFORM set_config('request.jwt.claims','',true);
    UPDATE usuarios SET status='revocado' WHERE id=v_id_rec;   -- como owner (hay admin activo → C3 ok)
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_rec)::text, true);
    v_ok:=false;
    BEGIN
      PERFORM check_in_manual_atomic(v_r2, 'revocado');
    EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'CUENTA_INACTIVA%'; END;
    IF NOT v_ok THEN RAISE EXCEPTION 'W3-02 FALLO: staff revocado pudo hacer check-in'; END IF;

    -- (c) la reserva r2 sigue confirmada (el bloqueo no la tocó)
    IF NOT EXISTS (SELECT 1 FROM reservas WHERE id=v_r2 AND status='confirmada') THEN
      RAISE EXCEPTION 'W3-02 FALLO: el bloqueo alteró la reserva';
    END IF;

    PERFORM set_config('request.jwt.claims','',true);
    RAISE EXCEPTION 'ROLLBACK_W3_RC08';
  EXCEPTION WHEN raise_exception THEN
    PERFORM set_config('request.jwt.claims','',true);
    IF SQLERRM = 'ROLLBACK_W3_RC08' THEN NULL; ELSE RAISE; END IF;
  END;
END;
$outer$;

-- ════════════════════════════════════════════════════════════════════════════
-- Resumen (devuelve tabla).
-- ════════════════════════════════════════════════════════════════════════════
SELECT 'W3-01: miembro no auto-cambia membresia_tier/bloqueado_hasta/membresia_activa_id/inscripcion_pagada_at' AS prueba, 'PRIVILEGIO_DENEGADO' AS espera, 'OK' AS resultado
UNION ALL SELECT 'W3-01: edit de perfil (nombre) sigue permitido', 'permitido', 'OK'
UNION ALL SELECT 'W3-01: owner/admin sí puede cambiar entitlement', 'permitido', 'OK'
UNION ALL SELECT 'W3-02: staff activo hace check-in', 'OK', 'OK'
UNION ALL SELECT 'W3-02: staff revocado con JWT vivo es denegado', 'CUENTA_INACTIVA', 'OK'
UNION ALL SELECT 'W2 FOR UPDATE + guards preservados en check-in', 'preservado', 'OK';

COMMIT;
