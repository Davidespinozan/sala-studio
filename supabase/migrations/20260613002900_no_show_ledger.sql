-- ============================================================================
-- NO-SHOW — rastro en el ledger (decisión: QUEMAR el crédito + dejar traza).
-- ----------------------------------------------------------------------------
-- El no-show quema el crédito que el socio gastó al reservar (penalización), y
-- esa política se mantiene. Pero hoy NO deja ningún asiento en el ledger: el
-- saldo baja al reservar (débito -1) y, al no devolverse, el crédito queda
-- "huérfano" sin un movimiento que explique por qué. Esto rompe la trazabilidad
-- del ledger (no podés reconstruir el saldo leyendo los movimientos).
--
-- FIX: al marcar no_show, insertar un movimiento tipo='no_show' con delta 0
-- (el saldo NO cambia: el crédito ya se había debitado al reservar; este asiento
-- solo documenta que se pierde como penalización). Se aplica en las DOS vías:
--   - recepcion_marcar_no_show (manual)
--   - marcar_no_shows (cron horario)
-- De paso, el cron deja de escribir la columna deprecada usuarios.no_shows_count
-- (ya lo hizo el RPC en 20260613001100; ninguna vista la consume).
-- ============================================================================

-- ── 1) Habilitar 'no_show' en el CHECK de membresia_movimientos.tipo ────────
-- Constraint inline con nombre autogenerado → lo ubicamos por introspección
-- (conkey = la columna `tipo`), robusto contra el nombre real.
DO $$
DECLARE v_attnum smallint; v_name text;
BEGIN
  SELECT attnum INTO v_attnum FROM pg_attribute
   WHERE attrelid = 'membresia_movimientos'::regclass AND attname = 'tipo' AND NOT attisdropped;
  SELECT conname INTO v_name FROM pg_constraint
   WHERE conrelid = 'membresia_movimientos'::regclass AND contype = 'c'
     AND conkey = ARRAY[v_attnum]::int2[]
   LIMIT 1;
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE membresia_movimientos DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

ALTER TABLE membresia_movimientos ADD CONSTRAINT membresia_movimientos_tipo_check
  CHECK (tipo IN ('alta', 'debito', 'devolucion', 'expiracion', 'ajuste', 'no_show'));

-- ── 2) Helper interno: deja la traza de no-show si hubo débito por esa reserva
--    y no se devolvió ni se trazó ya (anti-doble). delta 0 = el saldo no cambia.
CREATE OR REPLACE FUNCTION _registrar_no_show_ledger(p_reserva_id uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem_id uuid;
  v_tenant uuid;
  v_ya integer;
BEGIN
  -- La membresía que debitó esta reserva (si la hubo). Si no hay débito, el
  -- socio era tipo tiempo (ilimitado) → no hay crédito que quemar, nada que trazar.
  SELECT mm.membresia_id, mm.tenant_id INTO v_mem_id, v_tenant
  FROM membresia_movimientos mm
  WHERE mm.reserva_id = p_reserva_id AND mm.tipo = 'debito'
  LIMIT 1;

  IF v_mem_id IS NULL THEN
    RETURN;
  END IF;

  -- Anti-doble: si ya se devolvió o ya se trazó el no-show, no repetir.
  SELECT count(*) INTO v_ya FROM membresia_movimientos
   WHERE reserva_id = p_reserva_id AND tipo IN ('devolucion', 'no_show');
  IF v_ya > 0 THEN
    RETURN;
  END IF;

  INSERT INTO membresia_movimientos (
    membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
  ) VALUES (
    v_mem_id, v_tenant, 'no_show', 0, p_reserva_id,
    'no-show: crédito no devuelto (penalización)', p_actor
  );
END;
$$;

REVOKE ALL ON FUNCTION _registrar_no_show_ledger(uuid, uuid) FROM PUBLIC;

COMMENT ON FUNCTION _registrar_no_show_ledger(uuid, uuid) IS
  'Helper interno: deja un asiento tipo=no_show (delta 0) para una reserva que se debitó y no se devolvió. Documenta que el crédito se quema como penalización. Anti-doble por reserva_id.';

-- ── 3) recepcion_marcar_no_show — agrega la traza ───────────────────────────
CREATE OR REPLACE FUNCTION recepcion_marcar_no_show(
  p_reserva_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_res RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;

  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    p_motivo := 'Marcado como no-show por recepción';
  END IF;

  SELECT r.id, r.status, r.tenant_id, r.usuario_id, r.slot_inicio, r.recurso_id, u.nombre
  INTO v_res
  FROM reservas r
  LEFT JOIN usuarios u ON u.id = r.usuario_id
  WHERE r.id = p_reserva_id;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;
  IF v_res.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa reserva no pertenece a tu negocio';
  END IF;
  IF v_res.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_MARCABLE: solo una reserva confirmada se puede marcar como no-show (status actual: %)', v_res.status;
  END IF;

  -- La asistencia se computa desde reservas.status='no_show'; la columna
  -- contadora deprecada (20260519000000) ya no se toca.
  UPDATE reservas SET status = 'no_show', updated_at = now() WHERE id = p_reserva_id;

  -- Traza en el ledger: el crédito debitado se quema (penalización), delta 0.
  PERFORM _registrar_no_show_ledger(p_reserva_id, get_my_user_id());

  PERFORM _audrec_log(
    'clase.marcar_no_show', 'reserva', p_reserva_id, v_res.usuario_id, v_res.nombre,
    format('Marcó no-show de la reserva del %s. Motivo: %s',
           to_char(v_res.slot_inicio, 'DD/MM HH24:MI'), p_motivo),
    jsonb_build_object('slot_inicio', v_res.slot_inicio, 'recurso_id', v_res.recurso_id, 'motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'status', 'no_show');
END;
$$;
REVOKE ALL ON FUNCTION recepcion_marcar_no_show(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_marcar_no_show(uuid, text) TO authenticated;

-- ── 4) Cron marcar_no_shows — traza + deja de escribir no_shows_count ───────
CREATE OR REPLACE FUNCTION marcar_no_shows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservas_afectadas integer := 0;
  v_usuarios_bloqueados integer := 0;
  v_now timestamptz := now();
  v_bloqueo_dias integer;
  r record;
BEGIN
  FOR r IN
    SELECT
      res.id,
      res.usuario_id,
      res.tenant_id,
      res.folio,
      t.config AS tenant_config
    FROM reservas res
    JOIN tenants t ON t.id = res.tenant_id
    WHERE res.status = 'confirmada'
      AND res.check_in_at IS NULL
      AND res.slot_fin + interval '30 minutes' < v_now
  LOOP
    v_bloqueo_dias := COALESCE(
      (r.tenant_config->'penalizaciones'->>'no_show_bloqueo_dias')::integer,
      (r.tenant_config->>'no_show_bloqueo_dias')::integer,
      7
    );

    UPDATE reservas SET status = 'no_show' WHERE id = r.id;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    -- Traza en el ledger (crédito quemado, delta 0).
    PERFORM _registrar_no_show_ledger(r.id, NULL);

    -- Bloqueo temporal del socio. no_shows_count quedó deprecada (20260519000000)
    -- → no se escribe (consistente con recepcion_marcar_no_show).
    UPDATE usuarios
    SET bloqueado_hasta = GREATEST(
          COALESCE(bloqueado_hasta, v_now),
          v_now + (v_bloqueo_dias || ' days')::interval
        )
    WHERE id = r.usuario_id;
    v_usuarios_bloqueados := v_usuarios_bloqueados + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'timestamp', v_now
  );
END;
$$;

COMMENT ON FUNCTION marcar_no_shows() IS
'Marca como no_show las reservas confirmadas cuyo slot_fin+30min ya pasó sin
check-in, deja traza en el ledger (crédito quemado) y bloquea al socio por
tenant.config.penalizaciones.no_show_bloqueo_dias (default 7). Ya no escribe
la columna deprecada no_shows_count. Llamar desde cron externo cada hora.';

-- ============================================================================
-- TEST — marcar no-show NO devuelve el crédito (queda quemado) pero deja un
-- movimiento tipo='no_show' delta 0. Reversible.
-- ============================================================================
DO $$
DECLARE
  v_recep uuid; v_recep_auth uuid; v_tenant uuid;
  v_tier uuid; v_recurso uuid; v_suc uuid;
  v_auth uuid := gen_random_uuid(); v_socio uuid; v_mem uuid;
  v_clase uuid; v_reserva uuid;
  v_cred_antes int; v_cred_despues int; v_noshow int; v_devol int; v_status text;
BEGIN
  SELECT id, auth_id, tenant_id INTO v_recep, v_recep_auth, v_tenant
  FROM usuarios WHERE rol = 'recepcionista' AND auth_id IS NOT NULL LIMIT 1;
  IF v_recep IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay recepcionista con auth_id.'; RETURN; END IF;
  SELECT id INTO v_tier FROM tiers WHERE tenant_id = v_tenant AND activo AND tipo IN ('creditos','hibrido') LIMIT 1;
  SELECT id, sucursal_id INTO v_recurso, v_suc FROM recursos WHERE tenant_id = v_tenant AND activo LIMIT 1;
  IF v_tier IS NULL OR v_recurso IS NULL THEN
    RAISE NOTICE 'TEST SKIP: falta tier creditos/hibrido o recurso activo.'; RETURN;
  END IF;

  BEGIN
    INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth, 'authenticated', 'authenticated',
            'ns-'||substr(v_auth::text,1,8)||'@test.local', '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', (SELECT slug FROM tenants WHERE id = v_tenant), 'nombre', 'No Show'), now(), now());
    SELECT id INTO v_socio FROM usuarios WHERE auth_id = v_auth;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days', 5) RETURNING id INTO v_mem;

    -- Clase pasada (para que sea "no-show" lógico) + reserva confirmada + débito.
    INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status)
    VALUES (v_tenant, v_suc, v_recurso, (CURRENT_DATE - 1), '10:00', 60, 'Clase Pasada', 10, 'manual', 'programada')
    RETURNING id INTO v_clase;
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id)
    VALUES (v_tenant, v_recurso, v_socio, now() - interval '1 day', now() - interval '23 hours', 60, 0, 'confirmada', 'TEST-NS', v_clase)
    RETURNING id INTO v_reserva;
    UPDATE membresias SET creditos_restantes = creditos_restantes - 1 WHERE id = v_mem;  -- 5 → 4
    INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by)
    VALUES (v_mem, v_tenant, 'debito', -1, v_reserva, 'reserva test', v_socio);

    SELECT creditos_restantes INTO v_cred_antes FROM membresias WHERE id = v_mem;  -- 4

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);
    PERFORM recepcion_marcar_no_show(v_reserva, 'Test: no se presentó');

    SELECT status INTO v_status FROM reservas WHERE id = v_reserva;
    SELECT creditos_restantes INTO v_cred_despues FROM membresias WHERE id = v_mem;
    SELECT count(*) INTO v_noshow FROM membresia_movimientos WHERE reserva_id = v_reserva AND tipo = 'no_show';
    SELECT count(*) INTO v_devol  FROM membresia_movimientos WHERE reserva_id = v_reserva AND tipo = 'devolucion';

    IF v_status <> 'no_show' THEN RAISE EXCEPTION 'TEST FALLO: la reserva no quedó no_show (%).', v_status; END IF;
    IF v_cred_despues <> v_cred_antes THEN
      RAISE EXCEPTION 'TEST FALLO: el no-show alteró el saldo (antes=% despues=%); debe QUEMAR, no devolver.', v_cred_antes, v_cred_despues;
    END IF;
    IF v_noshow <> 1 THEN RAISE EXCEPTION 'TEST FALLO: falta el asiento tipo=no_show (hay %).', v_noshow; END IF;
    IF v_devol <> 0 THEN RAISE EXCEPTION 'TEST FALLO: hubo una devolución indebida (%).', v_devol; END IF;

    RAISE EXCEPTION 'ROLLBACK_NOSHOW';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_NOSHOW' THEN
      RAISE NOTICE 'TEST OK: no-show quema el crédito (saldo sin cambio) y deja asiento no_show (delta 0). Revertido.';
    ELSE RAISE; END IF;
  END;
END $$;
