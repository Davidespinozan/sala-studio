-- ============================================================================
-- ETAPA 2/3 — FUNCIONES: vigencia unificada, invitados por bolsa, cobros reales.
-- ----------------------------------------------------------------------------
-- Requiere la etapa 1 (20260713100000). Acá SÍ cambia el comportamiento.
--
-- A) pagos: la llave de idempotencia pasa a (tenant, referencia, concepto).
--    Una misma factura de Stripe puede traer DOS conceptos (plan + inscripción);
--    con la llave anterior el segundo chocaba contra el primero.
--
-- B) invitados_disponibles: la bolsa se gasta AL RESERVAR (created_at de la
--    reserva), no según la fecha de la clase. Así reservar hoy una clase del mes
--    que viene consume del periodo vigente, que es el que el socio pagó.
--
-- C) reservar_clase_atomic: el techo deja de ser "N invitados EN CADA CLASE" y
--    pasa a ser "N pases POR PERIODO". Antes, un socio con techo 2 podía traer 2
--    invitados a cada una de las 20 clases del mes: 40 pases gratis.
--
-- D) cancelar_reserva_atomic: BUG DE REEMBOLSO. Reservar con 2 invitados debita
--    3 créditos, pero cancelar devolvía 1 fijo → el socio perdía 2. La corrección
--    ya existía en 20260613003000 y una migración posterior la pisó
--    (20260620240000 partió de la versión vieja). Se restaura la fórmula real,
--    que ya usan cancelar_reserva_admin y cancelar_clase.
--
-- E) activar_suscripcion_socio (camino Stripe): para tipo='tiempo' ignoraba
--    duracion_dias y sumaba '1 month' fijo → un plan QUINCENAL habría vencido a
--    los 30 días. Ahora manda duracion_dias, igual que el camino de recepción.
--    Además registra el pago y marca la inscripción.
--
-- F) gestionar_membresia_socio (camino staff): registra el cobro en `pagos`
--    (plan/paquete + inscripción la primera vez) con el método que informe
--    recepción. Sin método → no registra dinero (cortesía / ya pagó online).
-- ============================================================================

-- ── A) idempotencia por concepto ────────────────────────────────────────────
DROP INDEX IF EXISTS pagos_referencia_unica;
CREATE UNIQUE INDEX IF NOT EXISTS pagos_referencia_unica
  ON pagos (tenant_id, referencia, concepto)
  WHERE referencia IS NOT NULL;

-- ── B) bolsa de invitados del periodo vigente ───────────────────────────────
CREATE OR REPLACE FUNCTION invitados_disponibles(p_usuario_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_incluidos integer := 0;
  v_usados integer := 0;
  v_inicio timestamptz;
  v_fin timestamptz;
BEGIN
  IF p_usuario_id <> get_my_user_id() AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  SELECT COALESCE(t.invitados_por_periodo, 0), m.periodo_actual_inicio, m.periodo_actual_fin
  INTO v_incluidos, v_inicio, v_fin
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('activa', 'trialing', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF NOT FOUND OR COALESCE(v_incluidos, 0) = 0 THEN
    RETURN jsonb_build_object('incluidos', 0, 'usados', 0, 'disponibles', 0);
  END IF;

  -- Créditos puros (sin vencimiento) → ventana = mes calendario.
  v_inicio := COALESCE(v_inicio, date_trunc('month', now()));
  v_fin    := COALESCE(v_fin, v_inicio + interval '1 month');

  -- El pase se gasta AL RESERVAR. 'no_show' lo quema (igual que el crédito);
  -- solo 'cancelada' lo devuelve, porque deja de contar en esta suma.
  SELECT COALESCE(SUM(r.invitados_count), 0)
  INTO v_usados
  FROM reservas r
  WHERE r.usuario_id = p_usuario_id
    AND r.status IN ('confirmada', 'completada', 'no_show')
    AND r.created_at >= v_inicio
    AND r.created_at <  v_fin;

  RETURN jsonb_build_object(
    'incluidos', v_incluidos,
    'usados', v_usados,
    'disponibles', GREATEST(v_incluidos - v_usados, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION invitados_disponibles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitados_disponibles(uuid) TO authenticated;

-- ── C) reservar_clase_atomic — invitados por bolsa ──────────────────────────
-- Es la función de 20260620100000 con UN bloque cambiado (el techo de invitados).
CREATE OR REPLACE FUNCTION reservar_clase_atomic(
  p_clase_id uuid,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_usuario usuarios;
  v_clase clases;
  v_recurso recursos;
  v_tenant tenants;
  v_now timestamptz := now();
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_min_anticipacion_h integer;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;
  v_existe_doble boolean;
  v_existe_continua boolean;
  v_permitir_continuas boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  -- Rol y gate de membresía
  v_es_socio boolean;
  v_mem_id uuid;
  v_mem_status text;
  v_mem_inicio timestamptz;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_nuevo_creditos integer;
  v_costo integer;
  v_tier_todas_sedes boolean;
  v_mem_sucursal uuid;

  -- Invitados por periodo (reemplaza el techo por clase)
  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = p_clase_id;
  SELECT * INTO v_tenant  FROM tenants  WHERE id = v_tenant_id;

  IF v_clase IS NULL OR v_clase.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;

  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);

  IF v_clase.status != 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible (status: %)', v_clase.status;
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso IS NULL THEN
    RAISE EXCEPTION 'RECURSO_NO_EXISTE: Sala no encontrada';
  END IF;
  IF NOT v_recurso.activo THEN
    RAISE EXCEPTION 'RECURSO_INACTIVO: Esta sala no está disponible';
  END IF;

  -- MAPA DE SALÓN: si la sala tiene layout, el socio reserva un LUGAR puntual.
  IF v_recurso.layout IS NOT NULL THEN
    IF p_invitados > 0 THEN
      RAISE EXCEPTION 'LUGAR_SIN_INVITADOS: En salas con lugar asignado, cada persona reserva su propio lugar';
    END IF;
    IF p_lugar_id IS NULL THEN
      RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para esta clase';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l
      WHERE l->>'id' = p_lugar_id
    ) THEN
      RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
    END IF;
    IF EXISTS (
      SELECT 1 FROM reservas
      WHERE clase_id = p_clase_id AND lugar_id = p_lugar_id
        AND status IN ('confirmada','completada')
    ) THEN
      RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elegí otro';
    END IF;
  ELSE
    p_lugar_id := NULL; -- sala sin mapa: se ignora cualquier lugar enviado.
  END IF;

  v_es_socio := v_usuario.rol = 'miembro';

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_es_socio THEN
    SELECT m.id, m.status, m.periodo_actual_inicio, m.periodo_actual_fin,
           m.creditos_restantes, t.tipo,
           t.acceso_todas_sucursales, m.sucursal_id,
           COALESCE(t.invitados_por_periodo, 0)
    INTO v_mem_id, v_mem_status, v_mem_inicio, v_mem_fin,
         v_mem_creditos, v_tier_tipo,
         v_tier_todas_sedes, v_mem_sucursal,
         v_inv_incluidos
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_user_id
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

    IF v_mem_id IS NULL THEN
      RAISE EXCEPTION 'SIN_MEMBRESIA: No tenés una membresía activa';
    END IF;

    IF v_mem_status = 'congelada' THEN
      RAISE EXCEPTION 'MEMBRESIA_CONGELADA: Tu membresía está pausada';
    END IF;

    IF v_mem_fin IS NOT NULL AND v_mem_fin <= v_now THEN
      RAISE EXCEPTION 'MEMBRESIA_VENCIDA: Tu membresía venció el %',
        to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
    END IF;
  END IF;

  IF v_es_socio THEN
    IF v_usuario.membresia_tier IS NULL OR
       NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
      RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
    END IF;
  END IF;

  -- Alcance por sede: si el plan no da acceso a todas las sedes, la clase debe
  -- ser de la sede a la que el socio se suscribió.
  IF v_es_socio AND NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: Tu plan solo cubre tu sede';
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- INVITADOS: bolsa POR PERIODO (antes era un techo por clase).
  -- La bolsa la define el plan (tiers.invitados_por_periodo) y se gasta al
  -- reservar. Cancelar una reserva devuelve sus pases (deja de contar acá).
  -- ───────────────────────────────────────────────────────────────────────
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;

  IF v_es_socio AND p_invitados > 0 THEN
    IF COALESCE(v_inv_incluidos, 0) = 0 THEN
      RAISE EXCEPTION 'INVITADOS_NO_INCLUIDOS: Tu plan no incluye pases de invitado';
    END IF;

    v_ventana_inicio := COALESCE(v_mem_inicio, date_trunc('month', v_now));
    v_ventana_fin    := COALESCE(v_mem_fin, v_ventana_inicio + interval '1 month');

    SELECT COALESCE(SUM(r.invitados_count), 0)
    INTO v_inv_usados
    FROM reservas r
    WHERE r.usuario_id = v_user_id
      AND r.status IN ('confirmada', 'completada', 'no_show')
      AND r.created_at >= v_ventana_inicio
      AND r.created_at <  v_ventana_fin;

    v_inv_disponibles := GREATEST(v_inv_incluidos - COALESCE(v_inv_usados, 0), 0);

    IF p_invitados > v_inv_disponibles THEN
      RAISE EXCEPTION
        'INVITADOS_EXCEDEN: Tu plan incluye % pase(s) de invitado por periodo y te quedan %',
        v_inv_incluidos, v_inv_disponibles;
    END IF;
  END IF;

  v_costo := 1 + p_invitados;
  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido')
     AND COALESCE(v_mem_creditos, 0) < v_costo THEN
    RAISE EXCEPTION 'SIN_CREDITOS: Necesitás % crédito(s) (vos + % invitado(s)) y te quedan %',
      v_costo, p_invitados, COALESCE(v_mem_creditos, 0);
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  v_min_anticipacion_h := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer,
    (v_tenant.config->>'min_anticipacion_horas')::integer,
    24);
  IF v_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE clase_id = p_clase_id
      AND usuario_id = v_user_id
      AND status IN ('confirmada','completada')
  ) INTO v_existe_doble;
  IF v_existe_doble THEN
    RAISE EXCEPTION 'YA_RESERVADO: Ya tenés una reserva activa en esta clase';
  END IF;

  v_permitir_continuas := COALESCE((v_tenant.config->'reserva'->>'permitir_continuas')::boolean, false);
  IF NOT v_permitir_continuas THEN
    SELECT EXISTS(
      SELECT 1 FROM reservas
      WHERE usuario_id = v_user_id
        AND status IN ('confirmada','completada')
        AND (slot_fin = v_slot_inicio OR slot_inicio = v_slot_fin)
    ) INTO v_existe_continua;
    IF v_existe_continua THEN
      RAISE EXCEPTION 'CONTINUA: No puedes reservar horas continuas';
    END IF;
  END IF;

  -- Cupo = PERSONAS. Con mapa, el cupo efectivo es la cantidad de lugares.
  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada','completada');

  v_cupo_efectivo := CASE
    WHEN v_recurso.layout IS NOT NULL
      THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
    ELSE v_clase.cupo_max
  END;

  IF v_cupos_ocupados + 1 + p_invitados > v_cupo_efectivo THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_cupo_efectivo;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas,
    clase_id, lugar_id
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, v_user_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas,
    p_clase_id, p_lugar_id
  )
  RETURNING id INTO v_reserva_id;

  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - v_costo
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -v_costo,
      v_reserva_id,
      'reserva ' || v_folio_nuevo
        || CASE WHEN p_invitados > 0 THEN ' (+' || p_invitados || ' invitado(s))' ELSE '' END,
      v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', p_clase_id,
    'lugar_id', p_lugar_id,
    'creditos_restantes', v_nuevo_creditos,
    'invitados_restantes', CASE
      WHEN v_es_socio AND COALESCE(v_inv_incluidos, 0) > 0
        THEN GREATEST(COALESCE(v_inv_disponibles, v_inv_incluidos) - p_invitados, 0)
      ELSE 0
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION reservar_clase_atomic(uuid, integer, text, text) TO authenticated;

-- ── D) cancelar_reserva_atomic — devolver TAMBIÉN los créditos de invitados ──
-- Es la función de 20260620240000 con la fórmula de reembolso corregida
-- (1 + invitados_count), igual que cancelar_reserva_admin y cancelar_clase.
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
  v_monto integer;  -- FIX: titular + invitados (espeja el débito de la reserva)
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

  IF v_reserva.usuario_id <> v_user_id AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: No puedes cancelar esta reserva';
  END IF;

  IF v_reserva.usuario_id <> v_user_id AND v_reserva.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: Esta reserva es de otro gimnasio';
  END IF;

  IF v_reserva.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: La reserva no está confirmada (status: %)', v_reserva.status;
  END IF;

  IF v_reserva.slot_inicio <= v_now THEN
    RAISE EXCEPTION 'RESERVA_PASADA: No podés cancelar una reserva cuya clase ya empezó';
  END IF;

  -- Ventana de cancelación (solo decide la devolución, no bloquea).
  SELECT * INTO v_tenant FROM tenants WHERE id = v_reserva.tenant_id;
  v_ventana_h := COALESCE(
    (v_tenant.config->'reserva'->>'cancelacion_min_horas')::integer,
    4
  );
  v_es_a_tiempo := v_now < (v_reserva.slot_inicio - (v_ventana_h || ' hours')::interval);

  -- Lo debitado al reservar fue 1 (titular) + invitados. Se devuelve lo mismo.
  v_monto := 1 + COALESCE(v_reserva.invitados_count, 0);

  -- Devolución de crédito (al DUEÑO, no a quien cancela).
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

      -- D-011 FALLBACK — reserva nacida de una promoción de lista de espera:
      -- el débito quedó atado al lista_espera_id, no al reserva_id.
      IF v_debit_count = 0 THEN
        SELECT le.id INTO v_le_origen
        FROM lista_espera le
        WHERE le.reserva_id = p_reserva_id
          AND le.status = 'promovido'
        LIMIT 1;

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

  UPDATE reservas
  SET status = 'cancelada',
      cancelada_at = v_now,
      cancelada_motivo = p_motivo,
      cancelada_por = v_user_id
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  IF v_devolver THEN
    UPDATE membresias
    SET creditos_restantes = COALESCE(creditos_restantes, 0) + v_monto
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, lista_espera_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_reserva.tenant_id, 'devolucion', v_monto,
      p_reserva_id, v_le_origen,
      CASE
        WHEN v_le_origen IS NOT NULL THEN
          'cancelación a tiempo de reserva promovida ' || COALESCE(v_reserva.folio, '(sin folio)')
        ELSE
          'cancelación a tiempo de reserva ' || COALESCE(v_reserva.folio, '(sin folio)')
      END
        || CASE WHEN COALESCE(v_reserva.invitados_count, 0) > 0
             THEN ' (+' || v_reserva.invitados_count || ' invitado(s))' ELSE '' END,
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
    'creditos_devueltos', CASE WHEN v_devolver THEN v_monto ELSE 0 END,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

-- ── E) activar_suscripcion_socio — vigencia real + registro del cobro ───────
-- La firma cambia (params nuevos con default). Se elimina la vieja para que no
-- queden dos overloads ambiguos.
DROP FUNCTION IF EXISTS activar_suscripcion_socio(uuid, uuid, text, text, timestamptz);

CREATE OR REPLACE FUNCTION activar_suscripcion_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_periodo_fin timestamptz DEFAULT NULL,
  -- Cobro real (lo informa el webhook de Stripe). NULL/0 → no registra dinero.
  p_monto_centavos integer DEFAULT NULL,
  p_referencia text DEFAULT NULL,
  p_inscripcion_centavos integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_socio usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_fin timestamptz;
  v_mem_id uuid;
  v_old_creditos integer;
  v_nuevo_creditos integer;
  v_es_paquete boolean;
  v_dias integer;
BEGIN
  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: solo socios pueden tener membresía';
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE';
  END IF;
  IF v_tier.tenant_id <> v_socio.tenant_id THEN
    RAISE EXCEPTION 'TIER_DE_OTRO_TENANT';
  END IF;
  IF v_tier.activo IS NOT TRUE THEN
    RAISE EXCEPTION 'TIER_INACTIVO';
  END IF;

  v_es_paquete := v_tier.tipo IN ('creditos', 'hibrido') AND p_stripe_subscription_id IS NULL;

  -- Días de vigencia del plan. duracion_dias es la fuente de verdad (quincenal
  -- = 15); el periodo solo es el fallback histórico si la columna está vacía.
  v_dias := COALESCE(
    v_tier.duracion_dias,
    CASE v_tier.periodo
      WHEN 'anual'     THEN 365
      WHEN 'quincenal' THEN 15
      ELSE 30
    END
  );

  v_fin := CASE
    WHEN v_tier.tipo = 'hibrido'  THEN v_now + (v_dias || ' days')::interval
    WHEN v_tier.tipo = 'creditos' THEN NULL
    -- tipo='tiempo': manda el periodo que informa Stripe; si no vino (alta
    -- manual o pago único), se usa la vigencia REAL del plan.
    ELSE COALESCE(p_periodo_fin, v_now + (v_dias || ' days')::interval)
  END;

  SELECT id, creditos_restantes INTO v_mem_id, v_old_creditos
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('activa', 'trialing', 'past_due', 'congelada')
  ORDER BY created_at DESC
  LIMIT 1;

  v_nuevo_creditos := CASE
    WHEN v_tier.tipo = 'tiempo' THEN NULL
    WHEN v_es_paquete           THEN COALESCE(v_old_creditos, 0) + COALESCE(v_tier.clases_incluidas, 0)
    ELSE COALESCE(v_tier.clases_incluidas, 0)
  END;

  IF v_mem_id IS NULL THEN
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin, commitment_ends_at,
      creditos_restantes, stripe_subscription_id, stripe_customer_id
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, 'activa',
      v_now, v_fin, v_now + interval '6 months',
      v_nuevo_creditos, p_stripe_subscription_id, p_stripe_customer_id
    )
    RETURNING id INTO v_mem_id;
  ELSE
    UPDATE membresias SET
      tier_id = p_tier_id,
      status = 'activa',
      periodo_actual_inicio = v_now,
      periodo_actual_fin = v_fin,
      creditos_restantes = v_nuevo_creditos,
      stripe_subscription_id = COALESCE(p_stripe_subscription_id, stripe_subscription_id),
      stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
      cancelada_at = NULL,
      cancelada_efectiva_at = NULL,
      updated_at = v_now
    WHERE id = v_mem_id;
  END IF;

  -- Ledger de créditos.
  IF v_tier.tipo IN ('creditos', 'hibrido') THEN
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_socio.tenant_id,
      CASE WHEN COALESCE(v_nuevo_creditos, 0) - COALESCE(v_old_creditos, 0) >= 0 THEN 'alta' ELSE 'ajuste' END,
      COALESCE(v_nuevo_creditos, 0) - COALESCE(v_old_creditos, 0),
      NULL,
      CASE WHEN v_es_paquete THEN 'compra de paquete ' || v_tier.slug ELSE 'activación de plan ' || v_tier.slug END,
      p_usuario_id
    );
  END IF;

  -- ── DINERO (nuevo): registrar lo que Stripe cobró de verdad ───────────────
  IF COALESCE(p_monto_centavos, 0) > 0 THEN
    INSERT INTO pagos (
      tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
      concepto, monto_centavos, moneda, metodo, referencia, cobrado_por
    ) VALUES (
      v_socio.tenant_id, NULL, p_usuario_id, v_mem_id, p_tier_id,
      CASE WHEN v_es_paquete THEN 'paquete' ELSE 'plan' END,
      p_monto_centavos, COALESCE(v_tier.moneda, 'MXN'), 'stripe', p_referencia, NULL
    )
    ON CONFLICT DO NOTHING;  -- el webhook puede reintentar
  END IF;

  IF COALESCE(p_inscripcion_centavos, 0) > 0 THEN
    INSERT INTO pagos (
      tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
      concepto, monto_centavos, moneda, metodo, referencia, cobrado_por
    ) VALUES (
      v_socio.tenant_id, NULL, p_usuario_id, v_mem_id, p_tier_id,
      'inscripcion', p_inscripcion_centavos, COALESCE(v_tier.moneda, 'MXN'),
      'stripe', p_referencia, NULL
    )
    ON CONFLICT DO NOTHING;

    UPDATE usuarios
    SET inscripcion_pagada_at = COALESCE(inscripcion_pagada_at, v_now)
    WHERE id = p_usuario_id;
  END IF;

  UPDATE usuarios SET
    membresia_activa_id = v_mem_id,
    membresia_tier = v_tier.slug,
    status = 'activo',
    stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
    updated_at = v_now
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
    'ok', true,
    'membresia_id', v_mem_id,
    'tier_slug', v_tier.slug,
    'periodo_fin', v_fin
  );
END;
$$;

-- ── F) gestionar_membresia_socio — registra el cobro de recepción ───────────
DROP FUNCTION IF EXISTS gestionar_membresia_socio(uuid, uuid, text);

CREATE OR REPLACE FUNCTION gestionar_membresia_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_motivo text DEFAULT NULL,
  -- Cobro real. NULL → no se registra dinero (cortesía, o ya pagó por Stripe).
  p_metodo_pago text DEFAULT NULL,
  -- Monto efectivamente cobrado. NULL → el precio de lista del plan.
  p_monto_centavos integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_actor_tenant_id uuid;
  v_socio usuarios;
  v_tier tiers;
  v_now timestamptz := now();

  v_anterior_id uuid;
  v_anterior_fin timestamptz;
  v_anterior_saldo integer;
  v_anterior_tier_tipo text;
  v_existe_anterior boolean := false;
  v_mismo_tipo boolean := false;

  v_nuevo_fin timestamptz;
  v_nuevo_saldo integer;
  v_modo text;
  v_delta_creditos integer;
  v_membresia_id uuid;
  v_motivo_final text;

  -- Dinero
  v_monto_plan integer;
  v_cobra_inscripcion boolean := false;
  v_inscripcion integer := 0;
  v_sucursal_id uuid;  -- la sede vive en la membresía, no en usuarios
BEGIN
  v_actor_id := get_my_user_id();
  v_actor_tenant_id := get_my_tenant_id();
  IF v_actor_id IS NULL OR v_actor_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff (admin/recepción) puede gestionar membresías';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;
  IF v_socio.tenant_id <> v_actor_tenant_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El socio no pertenece a tu gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Solo se pueden asignar membresías a usuarios con rol miembro';
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: El tier no existe';
  END IF;
  IF v_tier.tenant_id <> v_socio.tenant_id THEN
    RAISE EXCEPTION 'TIER_TENANT_INVALIDO: El tier no pertenece al mismo gimnasio que el socio';
  END IF;
  IF NOT v_tier.activo THEN
    RAISE EXCEPTION 'TIER_INACTIVO: El tier no está activo. Activalo desde Planes antes de asignarlo';
  END IF;

  IF p_metodo_pago IS NOT NULL
     AND p_metodo_pago NOT IN ('efectivo', 'tarjeta', 'transferencia', 'cortesia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido (%)', p_metodo_pago;
  END IF;

  SELECT m.id, m.periodo_actual_fin, m.creditos_restantes, t.tipo
  INTO v_anterior_id, v_anterior_fin, v_anterior_saldo, v_anterior_tier_tipo
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada', 'expirada')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  v_existe_anterior := v_anterior_id IS NOT NULL;
  v_mismo_tipo := v_existe_anterior AND v_anterior_tier_tipo = v_tier.tipo;

  IF NOT v_existe_anterior THEN
    v_modo := 'alta';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;

  ELSIF v_mismo_tipo THEN
    IF v_tier.duracion_dias IS NULL THEN
      v_nuevo_fin := NULL;
      v_modo := 'renovacion';
    ELSIF v_anterior_fin IS NOT NULL AND v_anterior_fin > v_now THEN
      v_nuevo_fin := v_anterior_fin + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion';
    ELSE
      v_nuevo_fin := v_now + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion_desde_hoy';
    END IF;

    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE COALESCE(v_anterior_saldo, 0) + COALESCE(v_tier.clases_incluidas, 0)
    END;

  ELSE
    v_modo := 'cambio_de_tipo';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;
  END IF;

  v_delta_creditos := COALESCE(v_nuevo_saldo, 0) - COALESCE(v_anterior_saldo, 0);

  IF v_existe_anterior THEN
    UPDATE membresias
    SET tier_id = p_tier_id,
        status = 'activa',
        periodo_actual_inicio = v_now,
        periodo_actual_fin = v_nuevo_fin,
        creditos_restantes = v_nuevo_saldo,
        updated_at = v_now
    WHERE id = v_anterior_id;
    v_membresia_id := v_anterior_id;
  ELSE
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin, creditos_restantes
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, 'activa',
      v_now, v_nuevo_fin, v_nuevo_saldo
    )
    RETURNING id INTO v_membresia_id;
  END IF;

  v_motivo_final := COALESCE(
    NULLIF(trim(p_motivo), ''),
    format('%s — tier %s', v_modo, v_tier.slug)
  );

  IF v_modo = 'cambio_de_tipo' AND COALESCE(v_anterior_saldo, 0) > 0 THEN
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'expiracion', -v_anterior_saldo,
      NULL,
      format('créditos perdidos por cambio de plan (tier %s)', v_tier.slug),
      v_actor_id
    );

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', COALESCE(v_nuevo_saldo, 0),
      NULL, v_motivo_final, v_actor_id
    );
  ELSE
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', v_delta_creditos,
      NULL, v_motivo_final, v_actor_id
    );
  END IF;

  -- ── DINERO (nuevo) ────────────────────────────────────────────────────────
  -- Sin método → no se registra cobro (asignación de cortesía o ya pagada online).
  IF p_metodo_pago IS NOT NULL THEN
    v_monto_plan := COALESCE(p_monto_centavos, v_tier.precio_centavos, 0);
    SELECT sucursal_id INTO v_sucursal_id FROM membresias WHERE id = v_membresia_id;

    IF v_monto_plan > 0 THEN
      INSERT INTO pagos (
        tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
        concepto, monto_centavos, moneda, metodo, notas, cobrado_por
      ) VALUES (
        v_socio.tenant_id, v_sucursal_id, p_usuario_id, v_membresia_id, p_tier_id,
        CASE WHEN v_tier.tipo IN ('creditos', 'hibrido') THEN 'paquete' ELSE 'plan' END,
        v_monto_plan, COALESCE(v_tier.moneda, 'MXN'), p_metodo_pago, v_motivo_final, v_actor_id
      );
    END IF;

    -- Inscripción: UNA sola vez por socio, en su primer plan.
    v_inscripcion := COALESCE(v_tier.inscripcion_centavos, 0);
    v_cobra_inscripcion := v_inscripcion > 0 AND v_socio.inscripcion_pagada_at IS NULL;

    IF v_cobra_inscripcion THEN
      INSERT INTO pagos (
        tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
        concepto, monto_centavos, moneda, metodo, notas, cobrado_por
      ) VALUES (
        v_socio.tenant_id, v_sucursal_id, p_usuario_id, v_membresia_id, p_tier_id,
        'inscripcion', v_inscripcion, COALESCE(v_tier.moneda, 'MXN'), p_metodo_pago,
        'inscripción', v_actor_id
      );

      UPDATE usuarios SET inscripcion_pagada_at = v_now WHERE id = p_usuario_id;
    END IF;
  END IF;

  UPDATE usuarios
  SET membresia_tier = v_tier.slug,
      membresia_activa_id = v_membresia_id,
      status = CASE
        WHEN status = 'pendiente_pago' THEN 'activo'
        ELSE status
      END
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
    'success', true,
    'membresia_id', v_membresia_id,
    'modo', v_modo,
    'tier_slug', v_tier.slug,
    'tier_nombre', v_tier.nombre,
    'tier_tipo', v_tier.tipo,
    'periodo_actual_fin', v_nuevo_fin,
    'creditos_restantes', v_nuevo_saldo,
    'delta_creditos', v_delta_creditos,
    'cobro_registrado', p_metodo_pago IS NOT NULL,
    'monto_plan_centavos', COALESCE(v_monto_plan, 0),
    'inscripcion_centavos', CASE WHEN v_cobra_inscripcion THEN v_inscripcion ELSE 0 END
  );
END;
$$;

REVOKE ALL ON FUNCTION gestionar_membresia_socio(uuid, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gestionar_membresia_socio(uuid, uuid, text, text, integer) TO authenticated;

COMMENT ON FUNCTION gestionar_membresia_socio(uuid, uuid, text, text, integer) IS
  'Alta/renovación manual de la membresía de un socio (staff). Vigencia = duracion_dias del tier (quincenal=15). Mismo tipo SUMA fechas/créditos; cambio de tipo RESETEA. Con p_metodo_pago registra el cobro en `pagos` (plan/paquete + inscripción la primera vez, ver usuarios.inscripcion_pagada_at); sin método no mueve dinero.';

-- ============================================================================
-- SELF-TEST — devuelve TABLA.
-- ============================================================================
WITH checks AS (
  SELECT 'reservar_clase_atomic: invitados por BOLSA (no por clase)' AS prueba,
         (SELECT pg_get_functiondef(oid) LIKE '%INVITADOS_NO_INCLUIDOS%'
            FROM pg_proc WHERE proname = 'reservar_clase_atomic' LIMIT 1) AS ok
  UNION ALL
  SELECT 'reservar_clase_atomic: ya no usa el fallback legacy max_invitados_por_tier',
         (SELECT pg_get_functiondef(oid) NOT LIKE '%max_invitados_por_tier%'
            FROM pg_proc WHERE proname = 'reservar_clase_atomic' LIMIT 1)
  UNION ALL
  SELECT 'cancelar_reserva_atomic: devuelve titular + invitados',
         (SELECT pg_get_functiondef(oid) LIKE '%1 + COALESCE(v_reserva.invitados_count%'
            FROM pg_proc WHERE proname = 'cancelar_reserva_atomic' LIMIT 1)
  UNION ALL
  SELECT 'activar_suscripcion_socio: vigencia por duracion_dias (no 1 month fijo)',
         (SELECT pg_get_functiondef(oid) NOT LIKE '%interval ''1 month''%'
            FROM pg_proc WHERE proname = 'activar_suscripcion_socio' LIMIT 1)
  UNION ALL
  SELECT 'activar_suscripcion_socio: firma nueva (8 args, registra pago)',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'activar_suscripcion_socio'
                 AND pronargs = 8)
  UNION ALL
  SELECT 'activar_suscripcion_socio: sin overload viejo (5 args)',
         NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'activar_suscripcion_socio'
                     AND pronargs = 5)
  UNION ALL
  SELECT 'gestionar_membresia_socio: firma nueva (5 args, cobra)',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gestionar_membresia_socio'
                 AND pronargs = 5)
  UNION ALL
  SELECT 'gestionar_membresia_socio: sin overload viejo (3 args)',
         NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gestionar_membresia_socio'
                     AND pronargs = 3)
  UNION ALL
  SELECT 'idempotencia de pagos por (tenant, referencia, concepto)',
         EXISTS (SELECT 1 FROM pg_indexes
                 WHERE indexname = 'pagos_referencia_unica'
                   AND indexdef LIKE '%concepto%')
)
SELECT CASE WHEN ok THEN '✅' ELSE '❌' END AS estado, prueba
FROM checks
ORDER BY ok, prueba;
