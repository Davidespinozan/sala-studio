-- ============================================================================
-- FIX #3 — reservar_clase_atomic ignoraba la anticipación configurada.
-- ----------------------------------------------------------------------------
-- El admin guarda config.reserva.anticipacion_min_horas (AjustesReglas.tsx),
-- pero la función leía la clave PLANA config->>'min_anticipacion_horas' (que
-- nadie escribe) → COALESCE caía siempre al default 24h. La regla del gimnasio
-- se ignoraba por completo.
--
-- Ya hubo un fix (20260517000001) con la clave anidada + fallback, pero
-- 20260524200000_reservar_clase_gate reescribió la función y REGRESÓ a la
-- clave plana. Recreamos reservar_clase_atomic VERBATIM de 20260524200000
-- cambiando solo la lectura de anticipación (anidada + fallback plano + 24).
-- ============================================================================

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
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio THEN
    SELECT m.id, m.status, m.periodo_actual_fin, m.creditos_restantes, t.tipo
    INTO v_mem_id, v_mem_status, v_mem_fin, v_mem_creditos, v_tier_tipo
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_user_id
      AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
    ORDER BY
      -- Si por algún motivo hay más de una fila "vigente", priorizar la más
      -- útil. activa > trialing > past_due > congelada; luego más reciente.
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

    -- Saldo — solo tipos con créditos
    IF v_tier_tipo IN ('creditos', 'hibrido')
       AND COALESCE(v_mem_creditos, 0) <= 0 THEN
      RAISE EXCEPTION 'SIN_CREDITOS: Te quedaste sin créditos en tu paquete';
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
    v_max_invitados := max_invitados_por_tier(v_usuario.membresia_tier);
    IF p_invitados > v_max_invitados THEN
      RAISE EXCEPTION 'INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
    END IF;
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

  -- Horas continuas (mismo usuario, slot adyacente en cualquier clase)
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE usuario_id = v_user_id
      AND status IN ('confirmada','completada')
      AND (slot_fin = v_slot_inicio OR slot_inicio = v_slot_fin)
  ) INTO v_existe_continua;
  IF v_existe_continua THEN
    RAISE EXCEPTION 'CONTINUA: No puedes reservar horas continuas';
  END IF;

  -- Cupo
  SELECT count(*) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada','completada');

  IF v_cupos_ocupados >= v_clase.cupo_max THEN
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
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - 1
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -1,
      v_reserva_id, 'reserva ' || v_folio_nuevo, v_user_id
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

REVOKE ALL ON FUNCTION reservar_clase_atomic(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reservar_clase_atomic(uuid, integer, text) TO authenticated;

COMMENT ON FUNCTION reservar_clase_atomic(uuid, integer, text) IS
  'Reserva una clase por clase_id. Gate de membresía (socios): SIN_MEMBRESIA / MEMBRESIA_CONGELADA / MEMBRESIA_VENCIDA / SIN_CREDITOS — corre antes del cupo. Débito de crédito (creditos/híbrido) post-cupo, atómico, con FOR UPDATE en membresias para serializar. Admin/recepcionista/staff bypassean el gate. Anticipación: config.reserva.anticipacion_min_horas con fallback plano y default 24 (fix #3). Folio "SAL-NNNNNN". tz de la sucursal de la clase.';

-- ============================================================================
-- TEST — la lectura de anticipación toma la clave que el admin SÍ escribe.
-- Mirror EXACTO del COALESCE de la función (línea de v_min_anticipacion_h):
-- seteamos config.reserva.anticipacion_min_horas = 7 (distinto del default 24)
-- y verificamos que la expresión resuelve 7, no 24. Savepoint + centinela.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_leido integer;
BEGIN
  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay tenants (el fix igual quedó aplicado).';
    RETURN;
  END IF;

  BEGIN  -- subtransacción reversible
    UPDATE tenants
    SET config = jsonb_set(COALESCE(config, '{}'::jsonb),
                           '{reserva,anticipacion_min_horas}', '7'::jsonb, true)
    WHERE id = v_tenant;

    SELECT COALESCE(
      (config->'reserva'->>'anticipacion_min_horas')::integer,
      (config->>'min_anticipacion_horas')::integer,
      24)
    INTO v_leido
    FROM tenants WHERE id = v_tenant;

    IF v_leido <> 7 THEN
      RAISE EXCEPTION 'TEST FALLO: la anticipación se leyó % (esperaba 7 desde config.reserva).', v_leido;
    END IF;

    RAISE EXCEPTION 'ROLLBACK_FIX_ANTIC';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_FIX_ANTIC' THEN NULL;
    ELSE RAISE; END IF;
  END;

  RAISE NOTICE 'TEST OK: anticipación se lee de config.reserva.anticipacion_min_horas (no de la clave plana). Revertido.';
END $$;
