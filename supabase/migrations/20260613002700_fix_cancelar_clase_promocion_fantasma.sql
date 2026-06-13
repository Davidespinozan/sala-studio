-- ============================================================================
-- FIX (ALTO) — cancelar_clase: promoción fantasma + crédito de espera perdido.
-- ----------------------------------------------------------------------------
-- cancelar_clase cancelaba las RESERVAS confirmadas ANTES de cerrar la lista de
-- espera y de marcar la clase. Cada UPDATE de reserva (confirmada→cancelada_admin)
-- dispara el trigger reservas_promover_lista_espera, que NO mira el estado de la
-- clase: como la clase seguía 'programada', promover_siguiente_en_espera
-- PROMOVÍA a alguien de la cola (le creaba reserva 'confirmada' y marcaba su
-- entrada 'promovido'). Después, el loop de devolución de lista de espera solo
-- procesa 'esperando' → esa persona quedaba:
--   - con una reserva 'confirmada' a una clase que se cancela,
--   - sin que se le devuelva el crédito que debitó al anotarse,
--   - y con una notificación de "te promovimos" a una clase cancelada.
--
-- FIX: invertir el orden. Primero devolvemos el crédito y CERRAMOS la lista de
-- espera ('esperando'→'cancelado'); recién después cancelamos las reservas. Con
-- la cola ya vacía, el trigger de promoción no encuentra a nadie 'esperando'
-- (promover corta con clase<>'programada' Y con cupo, pero acá ni siquiera hay
-- candidatos) → no hay promoción fantasma. El resto queda VERBATIM.
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

  -- ── Lista de espera PRIMERO: devolver crédito + cerrar ('esperando'→'cancelado')
  --    Se hace antes de cancelar las reservas para vaciar la cola: así el trigger
  --    reservas_promover_lista_espera (que dispara con cancelada_admin) no
  --    encuentra a nadie a quien promover → sin promoción fantasma. ──────────────
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
-- TEST — clase llena (cupo 1) con 1 reserva confirmada (A) + 1 en lista de
-- espera (B). Al cancelar: B NO debe quedar promovido ni con reserva confirmada,
-- y SÍ debe recuperar su crédito de espera. Savepoint + centinela.
-- ============================================================================
DO $$
DECLARE
  v_recep uuid; v_recep_auth uuid; v_tenant uuid;
  v_tier uuid; v_recurso uuid; v_suc uuid;
  v_auth_a uuid := gen_random_uuid(); v_a uuid; v_mem_a uuid;
  v_auth_b uuid := gen_random_uuid(); v_b uuid; v_mem_b uuid;
  v_clase uuid; v_reserva_a uuid; v_le_b uuid;
  v_le_status text; v_b_reservas int; v_b_cred int; v_b_devol int;
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
    -- Socios A y B con membresía de créditos.
    INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES
      ('00000000-0000-0000-0000-000000000000', v_auth_a, 'authenticated', 'authenticated',
       'cc-a-'||substr(v_auth_a::text,1,8)||'@test.local', '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', (SELECT slug FROM tenants WHERE id = v_tenant), 'nombre', 'Socio A'), now(), now()),
      ('00000000-0000-0000-0000-000000000000', v_auth_b, 'authenticated', 'authenticated',
       'cc-b-'||substr(v_auth_b::text,1,8)||'@test.local', '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('tenant_slug', (SELECT slug FROM tenants WHERE id = v_tenant), 'nombre', 'Socio B'), now(), now());
    SELECT id INTO v_a FROM usuarios WHERE auth_id = v_auth_a;
    SELECT id INTO v_b FROM usuarios WHERE auth_id = v_auth_b;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_a, v_tier, 'activa', now(), now() + interval '30 days', 4) RETURNING id INTO v_mem_a;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_b, v_tier, 'activa', now(), now() + interval '30 days', 4) RETURNING id INTO v_mem_b;

    -- Clase llena (cupo 1): A reservada, B en lista de espera con crédito debitado.
    INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status)
    VALUES (v_tenant, v_suc, v_recurso, (CURRENT_DATE + 3), '10:00', 60, 'Clase Llena', 1, 'manual', 'programada')
    RETURNING id INTO v_clase;

    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id)
    VALUES (v_tenant, v_recurso, v_a, now() + interval '3 days', now() + interval '3 days 1 hour', 60, 0, 'confirmada', 'TEST-CC-A', v_clase)
    RETURNING id INTO v_reserva_a;
    UPDATE membresias SET creditos_restantes = creditos_restantes - 1 WHERE id = v_mem_a;
    INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by)
    VALUES (v_mem_a, v_tenant, 'debito', -1, v_reserva_a, 'reserva test A', v_a);

    INSERT INTO lista_espera (tenant_id, clase_id, usuario_id, status)
    VALUES (v_tenant, v_clase, v_b, 'esperando') RETURNING id INTO v_le_b;
    UPDATE membresias SET creditos_restantes = creditos_restantes - 1 WHERE id = v_mem_b;  -- B: 4 → 3
    INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, lista_espera_id, motivo, created_by)
    VALUES (v_mem_b, v_tenant, 'debito', -1, NULL, v_le_b, 'lista de espera test B', v_b);

    -- Cancelar la clase como recepcionista.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);
    PERFORM cancelar_clase(v_clase, NULL, NULL, 'Test: instructor enfermo');

    -- B NO debe haber sido promovido.
    SELECT status INTO v_le_status FROM lista_espera WHERE id = v_le_b;
    SELECT count(*) INTO v_b_reservas FROM reservas WHERE clase_id = v_clase AND usuario_id = v_b AND status = 'confirmada';
    SELECT creditos_restantes INTO v_b_cred FROM membresias WHERE id = v_mem_b;
    SELECT count(*) INTO v_b_devol FROM membresia_movimientos WHERE lista_espera_id = v_le_b AND tipo = 'devolucion';

    IF v_le_status <> 'cancelado' THEN
      RAISE EXCEPTION 'TEST FALLO: la entrada de espera de B quedó "%" (esperado cancelado → promoción fantasma).', v_le_status;
    END IF;
    IF v_b_reservas <> 0 THEN
      RAISE EXCEPTION 'TEST FALLO: B quedó con % reserva(s) confirmada(s) a una clase cancelada.', v_b_reservas;
    END IF;
    IF v_b_devol <> 1 THEN
      RAISE EXCEPTION 'TEST FALLO: no se devolvió el crédito de lista de espera de B (devoluciones=%).', v_b_devol;
    END IF;
    IF v_b_cred <> 4 THEN
      RAISE EXCEPTION 'TEST FALLO: el saldo de B no volvió a 4 (es %).', v_b_cred;
    END IF;

    RAISE EXCEPTION 'ROLLBACK_CC_FANTASMA';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_CC_FANTASMA' THEN
      RAISE NOTICE 'TEST OK: al cancelar la clase, B NO fue promovido (entrada cancelada, sin reserva) y recuperó su crédito de espera. Revertido.';
    ELSE RAISE; END IF;
  END;
END $$;
