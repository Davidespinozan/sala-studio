-- ============================================================================
-- FIX (correctitud) — cancelar una reserva individual desde el admin/recepción
-- NO devolvía el crédito al socio.
-- ----------------------------------------------------------------------------
-- No existe ningún trigger que devuelva crédito cuando una reserva pasa a
-- 'cancelada_admin'. La devolución solo ocurría dentro de cancelar_clase (clase
-- entera). Pero el admin que cancela UNA reserva desde la ficha del socio o el
-- Dashboard lo hacía con un UPDATE directo a reservas → el socio por créditos
-- perdía su crédito y (en una de las vías) ni siquiera era notificado.
--
-- Este RPC unifica la cancelación admin de UNA reserva:
--   - Cancela → 'cancelada_admin' (dispara la promoción de lista de espera, que
--     acá SÍ queremos: el lugar liberado pasa al siguiente en cola).
--   - Devuelve el crédito SIEMPRE (cancelación del gimnasio, sin ventana), con
--     el monto correcto (1 + invitados), anti-doble por reserva_id.
--   - Notifica al socio (opcional).
-- ============================================================================

CREATE OR REPLACE FUNCTION cancelar_reserva_admin(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL,
  p_notificar boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_actor uuid := get_my_user_id();
  v_motivo text := COALESCE(NULLIF(trim(p_motivo), ''), 'Cancelada por el gimnasio');
  v_res reservas;
  v_clase_nombre text;
  v_socio_nombre text;
  v_mem_id uuid; v_tier_tipo text; v_debit integer; v_refund integer; v_monto integer;
  v_devolvio boolean := false;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden cancelar una reserva';
  END IF;

  SELECT * INTO v_res FROM reservas WHERE id = p_reserva_id;
  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;
  IF v_res.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa reserva no pertenece a tu negocio';
  END IF;
  IF v_res.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: la reserva no está confirmada (status: %)', v_res.status;
  END IF;

  SELECT nombre INTO v_clase_nombre FROM clases WHERE id = v_res.clase_id;
  SELECT nombre INTO v_socio_nombre FROM usuarios WHERE id = v_res.usuario_id;

  -- Cancelar. El trigger reservas_promover_lista_espera promueve al siguiente en
  -- cola (correcto: liberamos UN lugar, no cancelamos la clase).
  UPDATE reservas
  SET status = 'cancelada_admin', cancelada_at = now(),
      cancelada_motivo = v_motivo, cancelada_por = v_actor
  WHERE id = p_reserva_id;

  -- Devolución del crédito (cancelación del gimnasio = SIEMPRE, sin ventana).
  IF (SELECT rol FROM usuarios WHERE id = v_res.usuario_id) = 'miembro' THEN
    SELECT m.id, t.tipo INTO v_mem_id, v_tier_tipo
    FROM membresias m JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_res.usuario_id
      AND m.status IN ('trialing','activa','past_due','congelada')
    ORDER BY CASE m.status WHEN 'activa' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 WHEN 'congelada' THEN 3 END,
             m.created_at DESC
    LIMIT 1 FOR UPDATE OF m;

    IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos','hibrido') THEN
      SELECT count(*) INTO v_debit FROM membresia_movimientos
        WHERE membresia_id = v_mem_id AND reserva_id = p_reserva_id AND tipo = 'debito';
      SELECT count(*) INTO v_refund FROM membresia_movimientos
        WHERE membresia_id = v_mem_id AND reserva_id = p_reserva_id AND tipo = 'devolucion';
      IF v_debit > 0 AND v_refund = 0 THEN
        v_monto := 1 + COALESCE(v_res.invitados_count, 0);  -- espeja el débito
        UPDATE membresias SET creditos_restantes = COALESCE(creditos_restantes,0) + v_monto
          WHERE id = v_mem_id;
        INSERT INTO membresia_movimientos (
          membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
        ) VALUES (
          v_mem_id, v_tenant, 'devolucion', v_monto, p_reserva_id,
          'cancelación del gimnasio (' || COALESCE(v_clase_nombre, '') || ')', v_actor
        );
        v_devolvio := true;
      END IF;
    END IF;
  END IF;

  -- Notificación al socio.
  IF p_notificar THEN
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_tenant, v_res.usuario_id, 'reserva_cancelada', 'Reserva cancelada',
      'El gimnasio canceló tu reserva'
        || CASE WHEN v_clase_nombre IS NOT NULL THEN ' de ' || v_clase_nombre ELSE '' END || '.'
        || CASE WHEN v_devolvio THEN ' Se te devolvió el crédito.' ELSE '' END,
      jsonb_build_object('reserva_id', p_reserva_id, 'clase_id', v_res.clase_id)
    );
  END IF;

  PERFORM _audrec_log(
    'reserva.cancelar', 'reserva', p_reserva_id, v_res.usuario_id, v_socio_nombre,
    format('Canceló la reserva del %s%s. Motivo: %s',
           to_char(v_res.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN v_devolvio THEN ' (crédito devuelto)' ELSE '' END, v_motivo),
    jsonb_build_object('reserva_id', p_reserva_id, 'devuelto', v_devolvio, 'motivo', v_motivo)
  );

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id, 'devuelto', v_devolvio);
END $$;

REVOKE ALL ON FUNCTION cancelar_reserva_admin(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancelar_reserva_admin(uuid, text, boolean) TO authenticated;

COMMENT ON FUNCTION cancelar_reserva_admin(uuid, text, boolean) IS
  'Cancela UNA reserva desde admin/recepción: cancelada_admin + devuelve el crédito (1+invitados, siempre, sin ventana) + notifica. La promoción de lista de espera se dispara normalmente (libera el lugar al siguiente).';

-- ============================================================================
-- TEST — admin cancela la reserva de un socio por créditos: se devuelve el
-- crédito (no se quema) y queda el movimiento. Reversible.
-- ============================================================================
DO $$
DECLARE
  v_recep uuid; v_recep_auth uuid; v_tenant uuid;
  v_tier uuid; v_recurso uuid; v_suc uuid;
  v_auth uuid := gen_random_uuid(); v_socio uuid; v_mem uuid;
  v_clase uuid; v_reserva uuid;
  v_cred_antes int; v_cred_despues int; v_devol int; v_status text; v_notifs int;
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
            'cra-'||substr(v_auth::text,1,8)||'@test.local', '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', (SELECT slug FROM tenants WHERE id = v_tenant), 'nombre', 'Cancel Admin'), now(), now());
    SELECT id INTO v_socio FROM usuarios WHERE auth_id = v_auth;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days', 5) RETURNING id INTO v_mem;

    INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status)
    VALUES (v_tenant, v_suc, v_recurso, (CURRENT_DATE + 2), '10:00', 60, 'Clase CRA', 10, 'manual', 'programada')
    RETURNING id INTO v_clase;
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id)
    VALUES (v_tenant, v_recurso, v_socio, now() + interval '2 days', now() + interval '2 days 1 hour', 60, 0, 'confirmada', 'TEST-CRA', v_clase)
    RETURNING id INTO v_reserva;
    UPDATE membresias SET creditos_restantes = creditos_restantes - 1 WHERE id = v_mem;  -- 5 → 4
    INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by)
    VALUES (v_mem, v_tenant, 'debito', -1, v_reserva, 'reserva test', v_socio);

    SELECT creditos_restantes INTO v_cred_antes FROM membresias WHERE id = v_mem;  -- 4

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);
    PERFORM cancelar_reserva_admin(v_reserva, 'Test: la sala se inunda', true);

    SELECT status INTO v_status FROM reservas WHERE id = v_reserva;
    SELECT creditos_restantes INTO v_cred_despues FROM membresias WHERE id = v_mem;
    SELECT count(*) INTO v_devol FROM membresia_movimientos WHERE reserva_id = v_reserva AND tipo = 'devolucion';
    SELECT count(*) INTO v_notifs FROM notificaciones WHERE usuario_id = v_socio AND tipo = 'reserva_cancelada';

    IF v_status <> 'cancelada_admin' THEN RAISE EXCEPTION 'TEST FALLO: la reserva no quedó cancelada_admin (%).', v_status; END IF;
    IF v_cred_despues <> v_cred_antes + 1 THEN
      RAISE EXCEPTION 'TEST FALLO: el admin no devolvió el crédito (antes=% despues=%).', v_cred_antes, v_cred_despues;
    END IF;
    IF v_devol <> 1 THEN RAISE EXCEPTION 'TEST FALLO: falta el movimiento devolucion (%).', v_devol; END IF;
    IF v_notifs < 1 THEN RAISE EXCEPTION 'TEST FALLO: no se notificó al socio.'; END IF;

    RAISE EXCEPTION 'ROLLBACK_CRA';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_CRA' THEN
      RAISE NOTICE 'TEST OK: cancelar_reserva_admin devuelve el crédito (no lo quema) y notifica. Revertido.';
    ELSE RAISE; END IF;
  END;
END $$;
