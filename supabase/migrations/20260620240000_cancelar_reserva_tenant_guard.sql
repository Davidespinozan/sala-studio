-- ============================================================================
-- FIX (seguridad): cancelar_reserva_atomic permitía cancelación cruzada.
-- ----------------------------------------------------------------------------
-- La rama de staff solo validaba el ROL (is_recepcionista()), no el TENANT: una
-- recepción del gym A podía cancelar una reserva del gym B (y disparar su
-- reembolso/promoción de lista de espera). Sus hermanas (cancelar_reserva_admin)
-- sí lo chequean. Agregamos el guard de tenant en el camino de staff.
-- Es la MISMA función de 20260526100000 + ese IF.
-- ============================================================================

CREATE OR REPLACE FUNCTION cancelar_reserva_atomic(
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
  v_user_rol text;
  v_reserva reservas;
  v_tenant tenants;
  v_now timestamptz := now();

  -- Ventana
  v_ventana_h integer;
  v_es_a_tiempo boolean;

  -- Dueño de la reserva (puede ser distinto del que cancela)
  v_owner_id uuid;
  v_owner_rol text;

  -- Membresía + ledger del dueño
  v_mem_id uuid;
  v_mem_status text;
  v_tier_tipo text;
  v_debit_count integer;
  v_refund_count integer;

  -- D-011: fallback al origen lista_espera
  v_le_origen uuid;

  -- Resultado de la devolución
  v_devolver boolean := false;
  v_devolucion_motivo text := 'no_aplica';
  v_nuevo_creditos integer;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT rol INTO v_user_rol FROM usuarios WHERE id = v_user_id;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  -- Autorización: dueño o staff del tenant (admin/recepción).
  IF v_reserva.usuario_id <> v_user_id AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: No puedes cancelar esta reserva';
  END IF;

  -- Guard de tenant: el staff solo cancela reservas de SU gimnasio. (Si es el
  -- dueño cancelando lo suyo, su reserva ya pertenece a su tenant.) Sin esto, una
  -- recepción del tenant A podía cancelar reservas del tenant B.
  IF v_reserva.usuario_id <> v_user_id AND v_reserva.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: Esta reserva es de otro gimnasio';
  END IF;

  IF v_reserva.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: La reserva no está confirmada (status: %)', v_reserva.status;
  END IF;

  -- La clase ya empezó: nada se hace (ni cancelar, ni devolver).
  IF v_reserva.slot_inicio <= v_now THEN
    RAISE EXCEPTION 'RESERVA_PASADA: No podés cancelar una reserva cuya clase ya empezó';
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Ventana de cancelación (la ventana solo decide la devolución, no bloquea)
  -- ───────────────────────────────────────────────────────────────────────
  SELECT * INTO v_tenant FROM tenants WHERE id = v_reserva.tenant_id;
  v_ventana_h := COALESCE(
    (v_tenant.config->'reserva'->>'cancelacion_min_horas')::integer,
    4
  );
  v_es_a_tiempo := v_now < (v_reserva.slot_inicio - (v_ventana_h || ' hours')::interval);

  -- ───────────────────────────────────────────────────────────────────────
  -- Devolución de crédito (al DUEÑO, no a quien cancela)
  -- ───────────────────────────────────────────────────────────────────────
  v_owner_id := v_reserva.usuario_id;
  SELECT rol INTO v_owner_rol FROM usuarios WHERE id = v_owner_id;

  IF v_owner_rol = 'miembro' THEN
    SELECT m.id, m.status, t.tipo
    INTO v_mem_id, v_mem_status, v_tier_tipo
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_owner_id
      AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
    ORDER BY
      CASE m.status
        WHEN 'activa'    THEN 0
        WHEN 'trialing'  THEN 1
        WHEN 'past_due'  THEN 2
        WHEN 'congelada' THEN 3
      END,
      m.created_at DESC
    LIMIT 1
    FOR UPDATE OF m;

    IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos', 'hibrido') THEN
      -- Primer intento: débito directo por reserva_id (caso normal).
      SELECT count(*) INTO v_debit_count
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND reserva_id = p_reserva_id
        AND tipo = 'debito';

      SELECT count(*) INTO v_refund_count
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND reserva_id = p_reserva_id
        AND tipo = 'devolucion';

      -- ─────────────────────────────────────────────────────────────────
      -- D-011 FALLBACK — si no hubo débito por reserva_id, esta reserva
      -- puede venir de promoción de lista de espera. Buscar la entrada
      -- 'promovido' que apunta a esta reserva y contar débito/devolución
      -- por su lista_espera_id.
      -- ─────────────────────────────────────────────────────────────────
      IF v_debit_count = 0 THEN
        SELECT le.id INTO v_le_origen
        FROM lista_espera le
        WHERE le.reserva_id = p_reserva_id
          AND le.status = 'promovido'
        LIMIT 1;  -- redundante con el UNIQUE parcial, defensivo

        IF v_le_origen IS NOT NULL THEN
          SELECT count(*) INTO v_debit_count
          FROM membresia_movimientos
          WHERE membresia_id = v_mem_id
            AND lista_espera_id = v_le_origen
            AND tipo = 'debito';

          SELECT count(*) INTO v_refund_count
          FROM membresia_movimientos
          WHERE membresia_id = v_mem_id
            AND lista_espera_id = v_le_origen
            AND tipo = 'devolucion';
        END IF;
      END IF;

      IF v_debit_count > 0 AND v_refund_count = 0 THEN
        IF v_es_a_tiempo THEN
          v_devolver := true;
          v_devolucion_motivo := 'a_tiempo';
        ELSE
          v_devolucion_motivo := 'tarde';
        END IF;
      ELSE
        v_devolucion_motivo := 'sin_credito';
      END IF;
    ELSE
      v_devolucion_motivo := 'sin_credito';
    END IF;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Cancelar la reserva (siempre)
  -- ───────────────────────────────────────────────────────────────────────
  UPDATE reservas
  SET status = 'cancelada',
      cancelada_at = v_now,
      cancelada_motivo = p_motivo,
      cancelada_por = v_user_id
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  -- ───────────────────────────────────────────────────────────────────────
  -- Devolución atómica si aplica. lista_espera_id = v_le_origen (NULL para
  -- reservas normales, la entrada de origen para promovidas). El doble
  -- vínculo (reserva_id + lista_espera_id) cierra el anti-doble-refund por
  -- ambas claves.
  -- ───────────────────────────────────────────────────────────────────────
  IF v_devolver THEN
    UPDATE membresias
    SET creditos_restantes = COALESCE(creditos_restantes, 0) + 1
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, lista_espera_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_reserva.tenant_id, 'devolucion', 1,
      p_reserva_id, v_le_origen,
      CASE
        WHEN v_le_origen IS NOT NULL THEN
          'cancelación a tiempo de reserva promovida ' || COALESCE(v_reserva.folio, '(sin folio)')
        ELSE
          'cancelación a tiempo de reserva ' || COALESCE(v_reserva.folio, '(sin folio)')
      END,
      v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', p_reserva_id,
    'status', v_reserva.status,
    'devuelto', v_devolver,
    'devolucion_motivo', v_devolucion_motivo,
    'ventana_horas', v_ventana_h,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;
