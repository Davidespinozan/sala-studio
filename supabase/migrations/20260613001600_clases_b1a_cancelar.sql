-- ============================================================================
-- MODELO VIRTUAL — B1a: cancelar_clase (incluye fix del ALTO #1).
-- ----------------------------------------------------------------------------
-- Cancelar una clase desde Agenda solo marcaba clases.status='cancelada' y
-- DEJABA las reservas confirmadas: el socio quedaba con una reserva activa de
-- una clase que no ocurre, sin devolución de crédito y sin aviso (ALTO #1).
--
-- cancelar_clase hace todo bien y en el modelo virtual:
--   - Materializa la clase si es virtual (para tener fila que marcar).
--   - Cancela cada reserva confirmada → 'cancelada_admin', DEVUELVE el crédito
--     (cancelación del gimnasio = siempre, sin ventana) y NOTIFICA al socio.
--   - Devuelve el crédito de la lista de espera y la cierra (antes del UPDATE de
--     la clase, para no chocar con el trigger clases_limpiar_lista_espera).
--   - Marca la clase cancelada y registra en bitácora.
--
-- Acepta (p_clase_id) o (p_horario_id, p_fecha) — virtual.
-- ============================================================================

CREATE OR REPLACE FUNCTION cancelar_clase(
  p_clase_id uuid DEFAULT NULL,
  p_horario_id uuid DEFAULT NULL,
  p_fecha date DEFAULT NULL,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_actor uuid := get_my_user_id();
  v_clase_id uuid;
  v_clase clases;
  v_motivo text := COALESCE(NULLIF(trim(p_motivo), ''), 'Clase cancelada por el gimnasio');
  v_canceladas integer := 0;
  v_devueltos integer := 0;
  r RECORD;
  v_mem_id uuid; v_tier_tipo text; v_debit integer; v_refund integer; v_devolvio boolean;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden cancelar una clase';
  END IF;

  -- Resolver / materializar la clase.
  IF p_clase_id IS NOT NULL THEN
    v_clase_id := p_clase_id;
  ELSIF p_horario_id IS NOT NULL AND p_fecha IS NOT NULL THEN
    v_clase_id := materializar_clase(p_horario_id, p_fecha);
  ELSE
    RAISE EXCEPTION 'PARAMS: se requiere p_clase_id o (p_horario_id, p_fecha)';
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_clase_id;
  IF v_clase.id IS NULL THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: no encontramos esa clase';
  END IF;
  IF v_clase.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa clase no pertenece a tu gimnasio';
  END IF;
  IF v_clase.status = 'cancelada' THEN
    RAISE EXCEPTION 'CLASE_YA_CANCELADA: la clase ya estaba cancelada';
  END IF;

  -- ── Reservas confirmadas: cancelar + devolver crédito + notificar ──────────
  FOR r IN
    SELECT * FROM reservas
    WHERE clase_id = v_clase_id AND status = 'confirmada'
    FOR UPDATE
  LOOP
    UPDATE reservas
    SET status = 'cancelada_admin', cancelada_at = now(),
        cancelada_motivo = v_motivo, cancelada_por = v_actor
    WHERE id = r.id;
    v_canceladas := v_canceladas + 1;

    v_devolvio := false;
    -- Devolución: socio con tier creditos/hibrido y débito previo no devuelto.
    IF (SELECT rol FROM usuarios WHERE id = r.usuario_id) = 'miembro' THEN
      SELECT m.id, t.tipo INTO v_mem_id, v_tier_tipo
      FROM membresias m JOIN tiers t ON t.id = m.tier_id
      WHERE m.usuario_id = r.usuario_id
        AND m.status IN ('trialing','activa','past_due','congelada')
      ORDER BY CASE m.status WHEN 'activa' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 WHEN 'congelada' THEN 3 END,
               m.created_at DESC
      LIMIT 1 FOR UPDATE OF m;

      IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos','hibrido') THEN
        SELECT count(*) INTO v_debit FROM membresia_movimientos
          WHERE membresia_id = v_mem_id AND reserva_id = r.id AND tipo = 'debito';
        SELECT count(*) INTO v_refund FROM membresia_movimientos
          WHERE membresia_id = v_mem_id AND reserva_id = r.id AND tipo = 'devolucion';
        IF v_debit > 0 AND v_refund = 0 THEN
          UPDATE membresias SET creditos_restantes = COALESCE(creditos_restantes,0) + 1
            WHERE id = v_mem_id;
          INSERT INTO membresia_movimientos (
            membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
          ) VALUES (
            v_mem_id, v_tenant, 'devolucion', 1, r.id,
            'clase cancelada (' || COALESCE(v_clase.nombre,'') || ')', v_actor
          );
          v_devueltos := v_devueltos + 1;
          v_devolvio := true;
        END IF;
      END IF;
    END IF;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_tenant, r.usuario_id, 'clase_cancelada', 'Clase cancelada',
      'Tu clase ' || COALESCE(v_clase.nombre,'') || ' fue cancelada por el gimnasio.'
        || CASE WHEN v_devolvio THEN ' Se te devolvió el crédito.' ELSE '' END,
      jsonb_build_object('clase_id', v_clase_id, 'reserva_id', r.id)
    );
  END LOOP;

  -- ── Lista de espera: devolver crédito + cerrar (antes del UPDATE de la clase,
  --    para que el trigger clases_limpiar_lista_espera no la cierre sin refund) ─
  FOR r IN
    SELECT * FROM lista_espera
    WHERE clase_id = v_clase_id AND status = 'esperando'
    FOR UPDATE
  LOOP
    IF (SELECT rol FROM usuarios WHERE id = r.usuario_id) = 'miembro' THEN
      SELECT m.id, t.tipo INTO v_mem_id, v_tier_tipo
      FROM membresias m JOIN tiers t ON t.id = m.tier_id
      WHERE m.usuario_id = r.usuario_id
        AND m.status IN ('trialing','activa','past_due','congelada')
      ORDER BY CASE m.status WHEN 'activa' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 WHEN 'congelada' THEN 3 END,
               m.created_at DESC
      LIMIT 1 FOR UPDATE OF m;

      IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos','hibrido') THEN
        SELECT count(*) INTO v_debit FROM membresia_movimientos
          WHERE membresia_id = v_mem_id AND lista_espera_id = r.id AND tipo = 'debito';
        SELECT count(*) INTO v_refund FROM membresia_movimientos
          WHERE membresia_id = v_mem_id AND lista_espera_id = r.id AND tipo = 'devolucion';
        IF v_debit > 0 AND v_refund = 0 THEN
          UPDATE membresias SET creditos_restantes = COALESCE(creditos_restantes,0) + 1
            WHERE id = v_mem_id;
          INSERT INTO membresia_movimientos (
            membresia_id, tenant_id, tipo, delta_creditos, reserva_id, lista_espera_id, motivo, created_by
          ) VALUES (
            v_mem_id, v_tenant, 'devolucion', 1, NULL, r.id,
            'clase cancelada — salía de lista de espera (' || COALESCE(v_clase.nombre,'') || ')', v_actor
          );
          v_devueltos := v_devueltos + 1;
        END IF;
      END IF;
    END IF;

    UPDATE lista_espera SET status = 'cancelado' WHERE id = r.id;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_tenant, r.usuario_id, 'clase_cancelada', 'Clase cancelada',
      'La clase ' || COALESCE(v_clase.nombre,'') || ' en la que esperabas lugar fue cancelada por el gimnasio.',
      jsonb_build_object('clase_id', v_clase_id, 'lista_espera_id', r.id)
    );
  END LOOP;

  -- ── Marcar la clase cancelada ──────────────────────────────────────────────
  UPDATE clases
  SET status = 'cancelada', cancelada_at = now(), cancelada_motivo = v_motivo
  WHERE id = v_clase_id;

  PERFORM _audrec_log(
    'clase.cancelar', 'clase', v_clase_id, NULL, NULL,
    format('Canceló la clase "%s" del %s — %s reserva(s) cancelada(s), %s crédito(s) devuelto(s). Motivo: %s',
           COALESCE(v_clase.nombre,''), v_clase.fecha, v_canceladas, v_devueltos, v_motivo),
    jsonb_build_object('clase_id', v_clase_id, 'fecha', v_clase.fecha,
                       'reservas_canceladas', v_canceladas, 'creditos_devueltos', v_devueltos, 'motivo', v_motivo)
  );

  RETURN jsonb_build_object(
    'success', true, 'clase_id', v_clase_id,
    'reservas_canceladas', v_canceladas, 'creditos_devueltos', v_devueltos
  );
END $$;

REVOKE ALL ON FUNCTION cancelar_clase(uuid, uuid, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancelar_clase(uuid, uuid, date, text) TO authenticated;

-- ============================================================================
-- TEST — cancelar una clase con una reserva pagada: cancela la reserva,
-- devuelve el crédito y notifica al socio. Savepoint + centinela.
-- ============================================================================
DO $$
DECLARE
  v_recep uuid; v_recep_auth uuid; v_tenant uuid;
  v_tier uuid; v_recurso uuid; v_suc uuid;
  v_auth_socio uuid := gen_random_uuid(); v_socio uuid; v_mem uuid;
  v_clase uuid; v_reserva uuid;
  v_cred_antes int; v_cred_despues int;
  v_status_reserva text; v_status_clase text; v_notifs int; v_devol int;
BEGIN
  SELECT id, auth_id, tenant_id INTO v_recep, v_recep_auth, v_tenant
  FROM usuarios WHERE rol = 'recepcionista' AND auth_id IS NOT NULL LIMIT 1;
  IF v_recep IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay recepcionista con auth_id.'; RETURN; END IF;

  SELECT id INTO v_tier FROM tiers
   WHERE tenant_id = v_tenant AND activo AND tipo IN ('creditos','hibrido') LIMIT 1;
  SELECT id, sucursal_id INTO v_recurso, v_suc FROM recursos WHERE tenant_id = v_tenant AND activo LIMIT 1;
  IF v_tier IS NULL OR v_recurso IS NULL THEN
    RAISE NOTICE 'TEST SKIP: falta tier creditos/hibrido o recurso activo.'; RETURN;
  END IF;

  BEGIN
    -- Socio con membresía de créditos (5 créditos).
    INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth_socio, 'authenticated', 'authenticated',
            'cancel-clase-'||substr(v_auth_socio::text,1,8)||'@test.local',
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', (SELECT slug FROM tenants WHERE id = v_tenant), 'nombre', 'Cancel Clase'), now(), now());
    SELECT id INTO v_socio FROM usuarios WHERE auth_id = v_auth_socio;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days', 5) RETURNING id INTO v_mem;

    -- Clase manual futura + reserva confirmada del socio + débito.
    INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status)
    VALUES (v_tenant, v_suc, v_recurso, (CURRENT_DATE + 3), '10:00', 60, 'Clase Test Cancelar', 10, 'manual', 'programada')
    RETURNING id INTO v_clase;
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id)
    VALUES (v_tenant, v_recurso, v_socio, now() + interval '3 days', now() + interval '3 days 1 hour', 60, 0, 'confirmada', 'TEST-CANCEL', v_clase)
    RETURNING id INTO v_reserva;
    UPDATE membresias SET creditos_restantes = creditos_restantes - 1 WHERE id = v_mem;
    INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by)
    VALUES (v_mem, v_tenant, 'debito', -1, v_reserva, 'reserva test', v_socio);

    SELECT creditos_restantes INTO v_cred_antes FROM membresias WHERE id = v_mem;  -- 4

    -- Cancelar la clase como recepcionista.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);
    PERFORM cancelar_clase(v_clase, NULL, NULL, 'Test: instructor enfermo');

    SELECT status INTO v_status_reserva FROM reservas WHERE id = v_reserva;
    SELECT status INTO v_status_clase FROM clases WHERE id = v_clase;
    SELECT creditos_restantes INTO v_cred_despues FROM membresias WHERE id = v_mem;
    SELECT count(*) INTO v_devol FROM membresia_movimientos WHERE reserva_id = v_reserva AND tipo = 'devolucion';
    SELECT count(*) INTO v_notifs FROM notificaciones WHERE usuario_id = v_socio AND tipo = 'clase_cancelada';

    IF v_status_reserva <> 'cancelada_admin' THEN RAISE EXCEPTION 'TEST FALLO: la reserva no quedó cancelada_admin (%).', v_status_reserva; END IF;
    IF v_status_clase <> 'cancelada' THEN RAISE EXCEPTION 'TEST FALLO: la clase no quedó cancelada (%).', v_status_clase; END IF;
    IF v_cred_despues <> v_cred_antes + 1 THEN RAISE EXCEPTION 'TEST FALLO: no se devolvió el crédito (antes=% despues=%).', v_cred_antes, v_cred_despues; END IF;
    IF v_devol <> 1 THEN RAISE EXCEPTION 'TEST FALLO: falta el movimiento devolucion (%).', v_devol; END IF;
    IF v_notifs < 1 THEN RAISE EXCEPTION 'TEST FALLO: no se notificó al socio.'; END IF;

    RAISE EXCEPTION 'ROLLBACK_B1A';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_B1A' THEN NULL; ELSE RAISE; END IF;
  END;

  RAISE NOTICE 'TEST OK: cancelar_clase cancela la reserva (cancelada_admin), devuelve el crédito y notifica. Revertido.';
END $$;
