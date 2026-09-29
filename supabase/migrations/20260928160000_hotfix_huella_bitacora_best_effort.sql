-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Envuelto en BEGIN/COMMIT: todo-o-nada. Si cualquier prueba del self-test
-- falla, se revierte la migración entera (la función queda como estaba).
-- ============================================================================
BEGIN;

-- ============================================================================
-- HOTFIX W2 — check_in_por_huella: la bitácora vuelve a ser BEST-EFFORT
-- ----------------------------------------------------------------------------
-- W2 (20260928130000) reescribió check_in_por_huella para agregar el FOR UPDATE
-- (W2-03) y, al copiar la función, reintrodujo `PERFORM _audrec_log(...)` SIN el
-- bloque BEGIN … EXCEPTION WHEN OTHERS THEN NULL que había puesto
-- 20260814180000_fix_huella_bitacora_service_role.
--
-- El agente del lector entra por service_role, SIN JWT → _audrec_log no
-- encuentra actor (auth.uid() NULL) → RAISE 'NO_AUTORIZADO' → como todo es UNA
-- transacción, revertía el UPDATE de reservas: toda huella reconocida con
-- reserva válida fallaba con 400 "No se pudo registrar la entrada".
--
-- CAMBIO: ÚNICAMENTE se envuelve la llamada a _audrec_log. La función es la de
-- W2 verbatim en todo lo demás: FOR UPDATE OF r, filtro por sede del lector,
-- ventana, SIN_RESERVA, _guard_membresia_checkin, UPDATE, contrato de retorno,
-- REVOKE/GRANT. No toca W1 ni W3 (W3 no redefinió esta función).
-- ============================================================================

CREATE OR REPLACE FUNCTION check_in_por_huella(
  p_token text,
  p_usuario_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lector lectores_biometricos;
  v_socio usuarios;
  v_reserva reservas;
  v_recurso recursos;
  v_clase clases;
  v_ventana integer;
BEGIN
  SELECT * INTO v_lector
  FROM lectores_biometricos
  WHERE token_hash = _hash_token_lector(p_token);

  IF v_lector.id IS NULL THEN
    RAISE EXCEPTION 'LECTOR_DESCONOCIDO: Ese lector no está dado de alta';
  END IF;

  IF NOT v_lector.activo THEN
    RAISE EXCEPTION 'LECTOR_INACTIVO: Ese lector está desactivado';
  END IF;

  UPDATE lectores_biometricos SET ultimo_visto_at = now() WHERE id = v_lector.id;

  SELECT u.* INTO v_socio
  FROM usuarios u
  WHERE u.id = p_usuario_id
    AND u.tenant_id = v_lector.tenant_id
    AND EXISTS (
      SELECT 1 FROM credenciales_biometricas c
      WHERE c.usuario_id = u.id
        AND c.tenant_id = v_lector.tenant_id
        AND c.revocada_at IS NULL
    );

  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'HUELLA_NO_RECONOCIDA: Esa huella no está registrada en este gimnasio';
  END IF;

  v_ventana := ventana_check_in_min(v_lector.tenant_id);

  -- W2-03: FOR UPDATE OF r serializa el check-in de la reserva elegida; el segundo
  -- ingreso concurrente bloquea y luego ya no la encuentra 'confirmada'.
  SELECT r.* INTO v_reserva
  FROM reservas r
  JOIN recursos rec ON rec.id = r.recurso_id
  WHERE r.tenant_id = v_lector.tenant_id
    AND r.usuario_id = v_socio.id
    AND r.status = 'confirmada'
    AND p_at >= r.slot_inicio - (v_ventana || ' minutes')::interval
    AND p_at <= r.slot_fin + (v_ventana * 2 || ' minutes')::interval
    AND (
      v_lector.sucursal_id IS NULL
      OR rec.sucursal_id = v_lector.sucursal_id
    )
  ORDER BY abs(extract(epoch FROM (r.slot_inicio - p_at)))
  LIMIT 1
  FOR UPDATE OF r;

  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'SIN_RESERVA: % no tiene ninguna reserva para este momento',
      COALESCE(v_socio.nombre, v_socio.email);
  END IF;

  PERFORM _guard_membresia_checkin(v_socio.id);

  UPDATE reservas
  SET status = 'completada',
      check_in_at = p_at,
      check_in_by = NULL,
      check_in_method = 'huella'
  WHERE id = v_reserva.id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = v_reserva.clase_id;

  -- HOTFIX: bitácora BEST-EFFORT (restaura 20260814180000). El agente entra por
  -- service_role SIN JWT → _audrec_log lanza NO_AUTORIZADO y, sin este bloque,
  -- revertía el check-in entero. El bloque solo revierte su propio savepoint:
  -- el UPDATE de reservas de arriba queda firme.
  BEGIN
    PERFORM _audrec_log(
      'checkin.huella', 'reserva', v_reserva.id, v_socio.id, v_socio.nombre,
      format('Entró con huella por el lector "%s".', v_lector.nombre),
      jsonb_build_object('lector_id', v_lector.id, 'lector', v_lector.nombre)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- la bitácora es secundaria; nunca revierte la entrada
  END;

  RETURN jsonb_build_object(
    'success', true,
    'socio', jsonb_build_object(
      'id', v_socio.id,
      'nombre', v_socio.nombre,
      'avatar_url', v_socio.avatar_url
    ),
    'reserva_id', v_reserva.id,
    'clase', COALESCE(v_clase.nombre, v_recurso.nombre),
    'hora', to_char(v_reserva.slot_inicio, 'HH24:MI')
  );
END;
$$;

REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION check_in_por_huella(text, uuid, timestamptz) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST — DEVUELVE TABLA. Nada persiste: el escenario funcional corre en un
-- savepoint que se revierte con un centinela; los veredictos viven en variables
-- plpgsql (sobreviven al rollback) y se escriben DESPUÉS en la tabla temporal.
-- Corre SIN JWT = exactamente como entra el agente (service_role, sin usuario).
-- La prueba PARALELA real (dos conexiones) sigue BLOCKED: no hay DB no-productiva;
-- el FOR UPDATE se valida por estructura (prueba 10) + duplicado secuencial (4).
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _w2h (orden int, prueba text, resultado text) ON COMMIT DROP;

DO $t$
DECLARE
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_admin uuid;
  v_suc uuid; v_sala uuid; v_tier uuid; v_clase uuid;
  v_s1 uuid; v_s2 uuid; v_s3 uuid; v_r1 uuid; v_r3 uuid;
  v_slug text := 'zz-w2h-' || substr(md5(random()::text), 1, 6);
  v_token text := 'zz-w2h-token-' || md5(random()::text);
  v_ini timestamptz := now() + interval '10 minutes';
  v_at timestamptz; v_res jsonb; v_err text;
  v_st text; v_met text; v_cia timestamptz;
  r1 text; r2 text; r3 text; r4 text; r5 text; r6 text; r7 text; r8 text;
BEGIN
  BEGIN
    -- ── Escenario sintético (tenant zz-, se revierte entero) ──
    INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'W2H','gym_libre','activo') RETURNING id INTO v_tenant;
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
    VALUES (v_auth,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',v_slug||'-a@sala.dev',
            jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),'',now(),now(),now());
    UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth RETURNING id INTO v_admin;
    INSERT INTO sucursales (tenant_id,nombre,timezone,activa,orden) VALUES (v_tenant,'Sede','America/Mexico_City',true,0) RETURNING id INTO v_suc;
    INSERT INTO recursos (tenant_id,sucursal_id,slug,nombre,tipo,cupos,cupo_max_default,activo)
    VALUES (v_tenant,v_suc,'sala-1','Sala 1','sala_grupal',5,5,true) RETURNING id INTO v_sala;
    INSERT INTO tiers (tenant_id,slug,nombre,tipo,precio_centavos,moneda,activo,orden)
    VALUES (v_tenant,'mensual','Mensual','tiempo',100000,'MXN',true,0) RETURNING id INTO v_tier;
    INSERT INTO clases (tenant_id,sucursal_id,recurso_id,fecha,hora_inicio,duracion_minutos,cupo_max,status,nombre)
    VALUES (v_tenant,v_suc,v_sala,(v_ini AT TIME ZONE 'America/Mexico_City')::date,
            (v_ini AT TIME ZONE 'America/Mexico_City')::time,60,5,'programada','Clase W2H') RETURNING id INTO v_clase;
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-s1@x.dev','S1','miembro','activo') RETURNING id INTO v_s1;
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-s2@x.dev','S2','miembro','activo') RETURNING id INTO v_s2;
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-s3@x.dev','S3','miembro','activo') RETURNING id INTO v_s3;
    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin)
    VALUES (v_tenant,v_s1,v_tier,'activa',now()-interval '1 day',now()+interval '30 days'),
           (v_tenant,v_s2,v_tier,'activa',now()-interval '1 day',now()+interval '30 days'),
           (v_tenant,v_s3,v_tier,'activa',now()-interval '1 day',now()+interval '30 days');
    -- Lector de la sede + huella viva para los 3 socios (s2 NO tendrá reserva).
    INSERT INTO lectores_biometricos (tenant_id,sucursal_id,nombre,token_hash)
    VALUES (v_tenant,v_suc,'Lector W2H',_hash_token_lector(v_token));
    INSERT INTO credenciales_biometricas (tenant_id,usuario_id,dedo,plantilla,consentimiento_at)
    VALUES (v_tenant,v_s1,'der_indice','\x00'::bytea,now()),
           (v_tenant,v_s2,'der_indice','\x00'::bytea,now()),
           (v_tenant,v_s3,'der_indice','\x00'::bytea,now());

    -- Recepción (con JWT de admin) le crea reserva a s1 y s3.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
    v_r1 := (recepcion_crear_reserva(v_s1, v_clase, NULL, NULL, 0, 'test', NULL, 'w2h')->>'reserva_id')::uuid;
    v_r3 := (recepcion_crear_reserva(v_s3, v_clase, NULL, NULL, 0, 'test', NULL, 'w2h')->>'reserva_id')::uuid;
    SELECT slot_inicio INTO v_at FROM reservas WHERE id = v_r1;

    -- A partir de aquí: SIN JWT, como el agente.
    PERFORM set_config('request.jwt.claims', NULL, true);

    -- 1) Precondición: _audrec_log SÍ falla sin JWT (la condición del bug es real).
    BEGIN
      PERFORM _audrec_log('test.w2h','reserva',v_r1,v_s1,'S1','w2h','{}'::jsonb);
      r1 := 'FAIL: _audrec_log no falló sin JWT (no se reprodujo la condición)';
    EXCEPTION WHEN OTHERS THEN
      r1 := CASE WHEN SQLERRM LIKE 'NO_AUTORIZADO%' THEN 'OK' ELSE 'FAIL: ' || SQLERRM END;
    END;

    -- 2) Check-in por huella válido TERMINA con éxito aunque _audrec_log falle.
    BEGIN
      v_res := check_in_por_huella(v_token, v_s1, v_at);
      r2 := CASE WHEN (v_res->>'success')::boolean AND (v_res->>'reserva_id')::uuid = v_r1
                  AND v_res ? 'socio' AND v_res ? 'clase' AND v_res ? 'hora'
                 THEN 'OK' ELSE 'FAIL: ' || v_res::text END;
    EXCEPTION WHEN OTHERS THEN
      r2 := 'FAIL: ' || SQLERRM;
    END;

    -- 3) La mutación de la reserva quedó firme (no la revirtió la bitácora).
    SELECT status, check_in_method, check_in_at INTO v_st, v_met, v_cia FROM reservas WHERE id = v_r1;
    r3 := CASE WHEN v_st = 'completada' AND v_met = 'huella' AND v_cia = v_at
               THEN 'OK' ELSE format('FAIL: status=%s metodo=%s check_in_at=%s', v_st, v_met, v_cia) END;

    -- 4) Segundo check-in de la misma reserva → SIN_RESERVA (ya no está 'confirmada').
    BEGIN
      PERFORM check_in_por_huella(v_token, v_s1, v_at);
      r4 := 'FAIL: dejó un segundo check-in';
    EXCEPTION WHEN OTHERS THEN
      r4 := CASE WHEN SQLERRM LIKE 'SIN_RESERVA%' THEN 'OK' ELSE 'FAIL: ' || SQLERRM END;
    END;

    -- 5) Socio con huella pero SIN reserva → SIN_RESERVA (sin cambio).
    BEGIN
      PERFORM check_in_por_huella(v_token, v_s2, v_at);
      r5 := 'FAIL: dejó entrar sin reserva';
    EXCEPTION WHEN OTHERS THEN
      r5 := CASE WHEN SQLERRM LIKE 'SIN_RESERVA%' THEN 'OK' ELSE 'FAIL: ' || SQLERRM END;
    END;

    -- 6) Usuario sin huella en este gym → HUELLA_NO_RECONOCIDA (sin cambio).
    BEGIN
      PERFORM check_in_por_huella(v_token, gen_random_uuid(), v_at);
      r6 := 'FAIL: aceptó un usuario sin huella';
    EXCEPTION WHEN OTHERS THEN
      r6 := CASE WHEN SQLERRM LIKE 'HUELLA_NO_RECONOCIDA%' THEN 'OK' ELSE 'FAIL: ' || SQLERRM END;
    END;

    -- 7) Token desconocido → LECTOR_DESCONOCIDO (sin cambio).
    BEGIN
      PERFORM check_in_por_huella('token-que-no-existe-' || md5(random()::text), v_s3, v_at);
      r7 := 'FAIL: aceptó un token desconocido';
    EXCEPTION WHEN OTHERS THEN
      r7 := CASE WHEN SQLERRM LIKE 'LECTOR_DESCONOCIDO%' THEN 'OK' ELSE 'FAIL: ' || SQLERRM END;
    END;

    -- 8) Guard de membresía intacto: s3 tiene reserva pero su plan vence →
    --    MEMBRESIA_VENCIDA y la reserva NO se toca.
    UPDATE membresias SET status = 'expirada' WHERE usuario_id = v_s3;
    BEGIN
      PERFORM check_in_por_huella(v_token, v_s3, v_at);
      r8 := 'FAIL: dejó entrar con plan vencido';
    EXCEPTION WHEN OTHERS THEN
      r8 := CASE WHEN SQLERRM LIKE 'MEMBRESIA_VENCIDA%' THEN 'OK' ELSE 'FAIL: ' || SQLERRM END;
    END;
    SELECT status, check_in_method INTO v_st, v_met FROM reservas WHERE id = v_r3;
    IF r8 = 'OK' AND (v_st <> 'confirmada' OR v_met IS NOT NULL) THEN
      r8 := format('FAIL: rechazó pero mutó la reserva (status=%s metodo=%s)', v_st, v_met);
    END IF;

    RAISE EXCEPTION 'RB_W2H';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'RB_W2H' THEN v_err := SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', NULL, true);

  INSERT INTO _w2h VALUES
    (0, 'escenario sintético (setup)',                                COALESCE('ERROR: ' || v_err, 'OK')),
    (1, '1. precondición: _audrec_log sin JWT → NO_AUTORIZADO',       COALESCE(r1, 'SKIP (no llegó)')),
    (2, '2. huella válida sin JWT → success (bitácora no la tumba)',  COALESCE(r2, 'SKIP (no llegó)')),
    (3, '3. reserva quedó completada / huella / check_in_at',         COALESCE(r3, 'SKIP (no llegó)')),
    (4, '4. segundo check-in misma reserva → SIN_RESERVA',            COALESCE(r4, 'SKIP (no llegó)')),
    (5, '5. huella sin reserva → SIN_RESERVA',                        COALESCE(r5, 'SKIP (no llegó)')),
    (6, '6. usuario sin huella → HUELLA_NO_RECONOCIDA',               COALESCE(r6, 'SKIP (no llegó)')),
    (7, '7. token desconocido → LECTOR_DESCONOCIDO',                  COALESCE(r7, 'SKIP (no llegó)')),
    (8, '8. plan vencido → MEMBRESIA_VENCIDA sin mutar la reserva',   COALESCE(r8, 'SKIP (no llegó)'));
END $t$;

-- ── Contrato estructural: el hotfix no debilitó W1 / W2 / W3 ────────────────
DO $c$
DECLARE v_src text; v_f text[] := ARRAY[]::text[]; v_fn text;
BEGIN
  -- Huella: W2-03 + guard + bitácora envuelta (y una sola llamada).
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'check_in_por_huella';
  IF position('FOR UPDATE OF r' IN v_src) = 0 THEN v_f := array_append(v_f, 'huella:FOR_UPDATE_perdido'); END IF;
  IF position('_guard_membresia_checkin' IN v_src) = 0 THEN v_f := array_append(v_f, 'huella:guard_membresia_perdido'); END IF;
  IF position('v_lector.sucursal_id' IN v_src) = 0 THEN v_f := array_append(v_f, 'huella:filtro_sede_perdido'); END IF;
  IF v_src !~ 'BEGIN\s+PERFORM _audrec_log\(.*EXCEPTION WHEN OTHERS THEN\s+NULL;' THEN v_f := array_append(v_f, 'huella:bitacora_no_envuelta'); END IF;
  IF (length(v_src) - length(replace(v_src, 'PERFORM _audrec_log', ''))) / length('PERFORM _audrec_log') <> 1 THEN
    v_f := array_append(v_f, 'huella:mas_de_una_llamada_a_bitacora');
  END IF;
  INSERT INTO _w2h VALUES (9, '9. huella: FOR UPDATE + guard + sede + bitácora envuelta',
    CASE WHEN cardinality(v_f) = 0 THEN 'OK' ELSE 'FAIL: ' || array_to_string(v_f, ', ') END);

  -- W2-01/W2-02: advisory locks de cupo y de corte siguen puestos.
  v_f := ARRAY[]::text[];
  FOREACH v_fn IN ARRAY ARRAY['reservar_clase_atomic','recepcion_crear_reserva','hacer_corte_caja'] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE proname = v_fn;
    IF v_src IS NULL OR position('pg_advisory_xact_lock' IN v_src) = 0 THEN v_f := array_append(v_f, (v_fn || ':lock_perdido')); END IF;
  END LOOP;
  -- W2-03 + W3-02: check-in QR / manual intactos.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'check_in_atomic';
  IF position('FOR UPDATE' IN v_src) = 0 THEN v_f := array_append(v_f, 'qr:FOR_UPDATE'); END IF;
  IF position('CUENTA_INACTIVA' IN v_src) = 0 THEN v_f := array_append(v_f, 'qr:status_check'); END IF;
  IF position('_guard_membresia_checkin' IN v_src) = 0 THEN v_f := array_append(v_f, 'qr:guard_membresia'); END IF;
  IF position('_guard_sucursal_staff' IN v_src) = 0 THEN v_f := array_append(v_f, 'qr:guard_sucursal'); END IF;
  IF position('get_my_rol' IN v_src) > 0 THEN v_f := array_append(v_f, 'qr:get_my_rol'); END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'check_in_manual_atomic';
  IF position('FOR UPDATE' IN v_src) = 0 THEN v_f := array_append(v_f, 'manual:FOR_UPDATE'); END IF;
  IF position('CUENTA_INACTIVA' IN v_src) = 0 THEN v_f := array_append(v_f, 'manual:status_check'); END IF;
  IF position('_guard_membresia_checkin' IN v_src) > 0 THEN v_f := array_append(v_f, 'manual:no_debe_bloquear'); END IF;
  IF position('get_my_rol' IN v_src) > 0 THEN v_f := array_append(v_f, 'manual:get_my_rol'); END IF;
  -- W3-01: trigger de entitlement.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'trg_proteger_usuarios';
  IF position('membresia_activa_id' IN v_src) = 0 OR position('ULTIMO_ADMIN' IN v_src) = 0 THEN v_f := array_append(v_f, 'w3:trigger_entitlement'); END IF;
  INSERT INTO _w2h VALUES (10, '10. W2 locks + W2/W3 check-in QR/manual + W3 trigger intactos',
    CASE WHEN cardinality(v_f) = 0 THEN 'OK' ELSE 'FAIL: ' || array_to_string(v_f, ', ') END);

  -- W1: idempotencia intacta.
  v_f := ARRAY[]::text[];
  IF to_regclass('public.business_operations') IS NULL THEN v_f := array_append(v_f, 'w1:tabla'); END IF;
  IF to_regclass('public.business_operations_key') IS NULL THEN v_f := array_append(v_f, 'w1:indice_unico'); END IF;
  FOREACH v_fn IN ARRAY ARRAY['vender_productos','registrar_reembolso','registrar_cargo_pendiente','cobrar_cargo_pendiente',
                               'gestionar_membresia_socio','reembolsar_como_cortesia','cancelar_venta_producto',
                               'recepcion_asignar_plan','recepcion_renovar_membresia'] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE proname = v_fn;
    IF v_src IS NULL OR position('_op_begin' IN v_src) = 0 THEN v_f := array_append(v_f, ('w1:' || v_fn)); END IF;
  END LOOP;
  INSERT INTO _w2h VALUES (11, '11. W1 idempotencia (tabla + índice + 9 comandos)',
    CASE WHEN cardinality(v_f) = 0 THEN 'OK' ELSE 'FAIL: ' || array_to_string(v_f, ', ') END);

  -- Permisos: solo service_role ejecuta la huella.
  INSERT INTO _w2h VALUES (12, '12. permisos: solo service_role ejecuta check_in_por_huella',
    CASE WHEN has_function_privilege('service_role',  'check_in_por_huella(text,uuid,timestamptz)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated','check_in_por_huella(text,uuid,timestamptz)', 'EXECUTE')
          AND NOT has_function_privilege('anon',         'check_in_por_huella(text,uuid,timestamptz)', 'EXECUTE')
         THEN 'OK' ELSE 'FAIL: grants cambiaron' END);
END $c$;

-- Si CUALQUIER prueba no dio OK → se aborta todo (la función queda como estaba).
DO $g$
DECLARE v_mal text;
BEGIN
  SELECT string_agg(prueba || ' → ' || resultado, ' | ' ORDER BY orden) INTO v_mal
  FROM _w2h WHERE resultado <> 'OK';
  IF v_mal IS NOT NULL THEN
    RAISE EXCEPTION 'HOTFIX_W2H_ABORTADO (nada se aplicó): %', v_mal;
  END IF;
END $g$;

SELECT orden, prueba, resultado FROM _w2h ORDER BY orden;

COMMIT;
