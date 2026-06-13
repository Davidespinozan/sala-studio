-- ============================================================================
-- INVITADOS CONSUMEN CRÉDITO (decisión: cada lugar ocupado = 1 crédito).
-- ----------------------------------------------------------------------------
-- Una reserva con N invitados ocupa 1 (el socio) + N lugares en la sala, pero
-- hasta hoy cobraba 1 SOLO crédito: un socio con 1 crédito metía N+1 personas
-- pagando 1. Ahora el costo de una reserva = 1 + invitados, y la devolución
-- espeja ese costo. El débito/devolución de LISTA DE ESPERA queda en 1 (no
-- admite invitados).
--
-- Cambios (espejados para no fugar créditos):
--   - reservar_clase_atomic: gate de saldo exige (1 + invitados); débito
--     -(1 + invitados).
--   - cancelar_reserva_atomic: devolución (1 + invitados_count) de la reserva.
--   - cancelar_clase: devolución por reserva (1 + invitados_count).
-- Una reserva promovida desde lista de espera tiene invitados_count=0 → su
-- costo/devolución = 1, que coincide con el débito que hizo al anotarse.
-- ============================================================================

-- ── reservar_clase_atomic — saldo y débito por (1 + invitados) ──────────────
CREATE OR REPLACE FUNCTION reservar_clase_atomic(
  p_clase_id uuid,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL
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
  v_max_invitados integer;
  v_cupos_ocupados integer;
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
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_nuevo_creditos integer;
  v_costo integer;            -- 1 + invitados (créditos que cuesta la reserva)
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

  -- multisede-3: la tz es la de la SUCURSAL de la clase (fallback a la del tenant).
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

  -- Solo el rol 'miembro' está sujeto a gate/tier/débito. Los demás (admin,
  -- recepcionista, staff) operan por rol y bypassean toda la lógica de
  -- membresía.
  v_es_socio := v_usuario.rol = 'miembro';

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- GATE de membresía (solo socios). FOR UPDATE serializa el débito.
  -- El SALDO se valida más abajo, contra el costo real (1 + invitados).
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio THEN
    SELECT m.id, m.status, m.periodo_actual_fin, m.creditos_restantes, t.tipo
    INTO v_mem_id, v_mem_status, v_mem_fin, v_mem_creditos, v_tier_tipo
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

    -- Vencimiento — la política la encoda periodo_actual_fin, no el tipo
    -- (tipo=tiempo y tipo=hibrido SIEMPRE tienen fin; tipo=creditos puede
    -- tener fin si el paquete caduca, o NULL si son créditos puros eternos).
    IF v_mem_fin IS NOT NULL AND v_mem_fin <= v_now THEN
      RAISE EXCEPTION 'MEMBRESIA_VENCIDA: Tu membresía venció el %',
        to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
    END IF;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Tier permitido por el RECURSO (existente, solo socios)
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio THEN
    IF v_usuario.membresia_tier IS NULL OR
       NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
      RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
    END IF;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Invitados — el techo (EXCEDEN) aplica solo a socios; el validador de
  -- número negativo aplica a todos.
  -- ───────────────────────────────────────────────────────────────────────
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF v_es_socio THEN
    -- Nada hardcodeado: el máximo de invitados del tier del socio sale de
    -- tiers.reglas (editable por el admin), por tenant. Fallback a la función
    -- legacy max_invitados_por_tier solo si el tier no lo definió.
    v_max_invitados := COALESCE(
      (SELECT (t.reglas->>'max_invitados')::int FROM tiers t
        WHERE t.tenant_id = v_tenant_id AND t.slug = v_usuario.membresia_tier),
      max_invitados_por_tier(v_usuario.membresia_tier)
    );
    IF p_invitados > v_max_invitados THEN
      RAISE EXCEPTION 'INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
    END IF;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Saldo — cada lugar ocupado cuesta 1 crédito: el socio (1) + sus invitados.
  -- Solo tipos con créditos. Se valida acá (con p_invitados ya validado).
  -- ───────────────────────────────────────────────────────────────────────
  v_costo := 1 + p_invitados;
  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido')
     AND COALESCE(v_mem_creditos, 0) < v_costo THEN
    RAISE EXCEPTION 'SIN_CREDITOS: Necesitás % crédito(s) (vos + % invitado(s)) y te quedan %',
      v_costo, p_invitados, COALESCE(v_mem_creditos, 0);
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  -- fix #3: el admin guarda config.reserva.anticipacion_min_horas (AjustesReglas).
  -- 'min_anticipacion_horas' plano es legacy y nadie lo escribe → leemos la
  -- clave anidada con fallback a la plana y default 24. (20260524200000 había
  -- regresado a la plana, ignorando la config del admin → siempre 24h.)
  v_min_anticipacion_h := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer,
    (v_tenant.config->>'min_anticipacion_horas')::integer,
    24);
  IF v_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
  END IF;

  -- Doble reserva del mismo usuario en la misma clase
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE clase_id = p_clase_id
      AND usuario_id = v_user_id
      AND status IN ('confirmada','completada')
  ) INTO v_existe_doble;
  IF v_existe_doble THEN
    RAISE EXCEPTION 'YA_RESERVADO: Ya tenés una reserva activa en esta clase';
  END IF;

  -- Horas continuas (mismo usuario, slot adyacente en cualquier clase).
  -- fix M3: solo se bloquea si el tenant NO permite continuas
  -- (config.reserva.permitir_continuas, default false). Antes se bloqueaba
  -- SIEMPRE, ignorando el toggle de AjustesReglas.
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

  -- Cupo
  -- Cupo = PERSONAS: cada reserva ocupa 1 + sus invitados. La nueva reserva suma
  -- 1 (el socio) + p_invitados.
  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada','completada');

  IF v_cupos_ocupados + 1 + p_invitados > v_clase.cupo_max THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_clase.cupo_max;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas,
    clase_id
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, v_user_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas,
    p_clase_id
  )
  RETURNING id INTO v_reserva_id;

  -- ───────────────────────────────────────────────────────────────────────
  -- Débito de crédito (solo socios con tier creditos/hibrido). Atómico con
  -- el INSERT de la reserva: si algo arriba abortó, esto nunca corrió.
  -- Cuesta 1 + invitados (cada lugar ocupado = 1 crédito).
  -- ───────────────────────────────────────────────────────────────────────
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
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

-- ── cancelar_reserva_atomic — devolución por (1 + invitados_count) ──────────
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

  v_ventana_h integer;
  v_es_a_tiempo boolean;

  v_owner_id uuid;
  v_owner_rol text;

  v_mem_id uuid;
  v_mem_status text;
  v_tier_tipo text;
  v_debit_count integer;
  v_refund_count integer;

  v_le_origen uuid;

  v_devolver boolean := false;
  v_devolucion_motivo text := 'no_aplica';
  v_nuevo_creditos integer;
  v_monto integer;            -- crédito a devolver = 1 + invitados de la reserva
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

  IF v_reserva.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: La reserva no está confirmada (status: %)', v_reserva.status;
  END IF;

  IF v_reserva.slot_inicio <= v_now THEN
    RAISE EXCEPTION 'RESERVA_PASADA: No podés cancelar una reserva cuya clase ya empezó';
  END IF;

  -- Costo de la reserva = 1 (el socio) + sus invitados. La devolución espeja
  -- exactamente lo debitado (una reserva promovida tiene invitados_count=0 → 1).
  v_monto := 1 + COALESCE(v_reserva.invitados_count, 0);

  -- Ventana de cancelación (solo decide la devolución, no bloquea)
  SELECT * INTO v_tenant FROM tenants WHERE id = v_reserva.tenant_id;
  v_ventana_h := COALESCE(
    (v_tenant.config->'reserva'->>'cancelacion_min_horas')::integer,
    4
  );
  v_es_a_tiempo := v_now < (v_reserva.slot_inicio - (v_ventana_h || ' hours')::interval);

  -- Devolución de crédito (al DUEÑO, no a quien cancela)
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

      -- D-011 FALLBACK — reserva venida de promoción de lista de espera:
      -- el débito quedó bajo lista_espera_id (monto 1, sin invitados).
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

  -- Cancelar la reserva (siempre)
  UPDATE reservas
  SET status = 'cancelada',
      cancelada_at = v_now,
      cancelada_motivo = p_motivo,
      cancelada_por = v_user_id
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  -- Devolución atómica si aplica. Espeja el costo (1 + invitados).
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

-- ── cancelar_clase — devolución por reserva = (1 + invitados_count) ─────────
-- Igual que la versión vigente (loops invertidos del fix de promoción fantasma),
-- solo cambia el monto de la devolución de RESERVAS: de +1 a (1 + invitados).
-- La devolución de LISTA DE ESPERA queda en 1 (no admite invitados).
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
  v_monto integer;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden cancelar una clase';
  END IF;

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

  -- ── Lista de espera PRIMERO (evita promoción fantasma): devolver 1 + cerrar ─
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

  -- ── Reservas confirmadas: cancelar + devolver (1 + invitados) + notificar ──
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
          v_monto := 1 + COALESCE(r.invitados_count, 0);  -- espeja el débito
          UPDATE membresias SET creditos_restantes = COALESCE(creditos_restantes,0) + v_monto
            WHERE id = v_mem_id;
          INSERT INTO membresia_movimientos (
            membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
          ) VALUES (
            v_mem_id, v_tenant, 'devolucion', v_monto, r.id,
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

-- ============================================================================
-- TEST — reservar con 2 invitados cobra 3 créditos; cancelar a tiempo devuelve
-- 3; y el saldo justo (2 créditos para costo 3) da SIN_CREDITOS. Reversible.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid; v_tier uuid; v_recurso uuid; v_suc uuid; v_tier_slug text;
  v_auth uuid := gen_random_uuid(); v_socio uuid; v_mem uuid;
  v_clase uuid; v_res_id uuid;
  v_saldo int; v_delta int; v_res jsonb; v_dev jsonb; v_capturado text;
BEGIN
  -- Tenant con tier de créditos que permita >=2 invitados.
  SELECT t.tenant_id, t.id, t.slug INTO v_tenant, v_tier, v_tier_slug
  FROM tiers t
  WHERE t.activo AND t.tipo IN ('creditos','hibrido')
    AND COALESCE((t.reglas->>'max_invitados')::int, max_invitados_por_tier(t.slug)) >= 2
  LIMIT 1;
  IF v_tier IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay tier creditos/hibrido con max_invitados>=2.'; RETURN; END IF;

  SELECT id, sucursal_id INTO v_recurso, v_suc FROM recursos
   WHERE tenant_id = v_tenant AND activo AND v_tier_slug = ANY(tiers_permitidos) LIMIT 1;
  IF v_recurso IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay recurso activo que permita el tier.'; RETURN; END IF;

  BEGIN
    INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth, 'authenticated', 'authenticated',
            'inv-'||substr(v_auth::text,1,8)||'@test.local', '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', (SELECT slug FROM tenants WHERE id = v_tenant), 'nombre', 'Inv Test'), now(), now());
    SELECT id INTO v_socio FROM usuarios WHERE auth_id = v_auth;
    -- El socio necesita el cache de tier para el gate TIER_NO_PERMITIDO.
    UPDATE usuarios SET status='activo', membresia_tier = v_tier_slug WHERE id = v_socio;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '60 days', 5) RETURNING id INTO v_mem;

    -- Clase futura con cupo holgado.
    INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status)
    VALUES (v_tenant, v_suc, v_recurso, (CURRENT_DATE + 10), '10:00', 60, 'Clase Inv', 20, 'manual', 'programada')
    RETURNING id INTO v_clase;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

    -- Reservar con 2 invitados → cuesta 3 créditos (5 → 2).
    v_res := reservar_clase_atomic(v_clase, 2, NULL);
    v_res_id := (v_res->>'reserva_id')::uuid;
    SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
    SELECT delta_creditos INTO v_delta FROM membresia_movimientos WHERE reserva_id = v_res_id AND tipo='debito';
    IF v_saldo <> 2 THEN RAISE EXCEPTION 'TEST FALLO: tras reservar con 2 invitados el saldo es % (esperado 2).', v_saldo; END IF;
    IF v_delta <> -3 THEN RAISE EXCEPTION 'TEST FALLO: el débito fue % (esperado -3).', v_delta; END IF;

    -- Cancelar a tiempo → devuelve 3 (2 → 5).
    v_dev := cancelar_reserva_atomic(v_res_id, 'Test cancelar');
    SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
    SELECT delta_creditos INTO v_delta FROM membresia_movimientos WHERE reserva_id = v_res_id AND tipo='devolucion';
    IF (v_dev->>'devuelto')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TEST FALLO: no devolvió (a tiempo).'; END IF;
    IF v_saldo <> 5 THEN RAISE EXCEPTION 'TEST FALLO: tras cancelar el saldo es % (esperado 5).', v_saldo; END IF;
    IF v_delta <> 3 THEN RAISE EXCEPTION 'TEST FALLO: la devolución fue % (esperado 3).', v_delta; END IF;

    -- Gate: dejar saldo 2 y pedir 2 invitados (costo 3) → SIN_CREDITOS.
    UPDATE membresias SET creditos_restantes = 2 WHERE id = v_mem;
    v_capturado := NULL;
    BEGIN
      PERFORM reservar_clase_atomic(v_clase, 2, NULL);
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'SIN_CREDITOS%' THEN v_capturado := 'ok'; ELSE RAISE; END IF;
    END;
    IF v_capturado IS NULL THEN
      RAISE EXCEPTION 'TEST FALLO: reservar con saldo 2 y costo 3 NO dio SIN_CREDITOS.';
    END IF;

    RAISE EXCEPTION 'ROLLBACK_INVITADOS';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_INVITADOS' THEN
      RAISE NOTICE 'TEST OK: invitados consumen crédito (reservar 2 inv = -3; cancelar = +3; saldo insuficiente = SIN_CREDITOS). Revertido.';
    ELSE RAISE; END IF;
  END;
END $$;
