-- ============================================================================
-- RECEPCIÓN — crear reserva (WALK-IN)
-- ----------------------------------------------------------------------------
-- Hueco grave: si un socio llegaba al mostrador sin haber reservado, recepción
-- NO podía meterlo a la clase. Las dos RPCs de reserva (reservar_clase_atomic /
-- reservar_clase_virtual) reservan para UNO MISMO (get_my_user_id), así que el
-- staff no podía usarlas para otro.
--
-- Esta función reserva EN NOMBRE DE UN SOCIO. Mantiene TODAS las reglas de
-- negocio (membresía viva, plan con acceso a la sala, sede, cupo, créditos,
-- bolsa de invitados, mapa de salón, doble reserva) y solo levanta las que no
-- tienen sentido en el mostrador:
--
--   · Anticipación mínima: un walk-in es, por definición, sobre la hora. Si el
--     gym exige 24h de anticipación, esa regla es para el socio desde la app,
--     no para el recepcionista que lo tiene enfrente.
--   · Horas continuas: si el socio quiere encadenar dos clases y el staff lo
--     autoriza, se permite.
--
-- Acepta clase REAL (p_clase_id) o VIRTUAL (p_horario_id + p_fecha): en el
-- modelo de clases virtuales, la clase se materializa recién al reservar.
-- ============================================================================

CREATE OR REPLACE FUNCTION recepcion_crear_reserva(
  p_usuario_id uuid,
  p_clase_id uuid DEFAULT NULL,
  p_horario_id uuid DEFAULT NULL,
  p_fecha date DEFAULT NULL,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_tenant_id uuid;
  v_socio usuarios;
  v_clase clases;
  v_clase_id uuid;
  v_recurso recursos;
  v_now timestamptz := now();
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  -- Membresía
  v_mem_id uuid;
  v_mem_status text;
  v_mem_inicio timestamptz;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_tier_todas_sedes boolean;
  v_mem_sucursal uuid;
  v_nuevo_creditos integer;
  v_costo integer;

  -- Invitados por periodo
  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
BEGIN
  v_actor_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_actor_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden reservar por un socio';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;
  IF v_socio.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El socio es de otro gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Solo se reserva para socios';
  END IF;

  -- Clase virtual → se materializa ahora (mismo camino que el socio).
  v_clase_id := p_clase_id;
  IF v_clase_id IS NULL THEN
    IF p_horario_id IS NULL OR p_fecha IS NULL THEN
      RAISE EXCEPTION 'CLASE_REQUERIDA: Falta la clase (o el horario + fecha)';
    END IF;
    v_clase_id := materializar_clase(p_horario_id, p_fecha);
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_clase_id;
  IF v_clase IS NULL OR v_clase.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;
  IF v_clase.status <> 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible (status: %)', v_clase.status;
  END IF;

  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso IS NULL OR NOT v_recurso.activo THEN
    RAISE EXCEPTION 'RECURSO_INACTIVO: Esta sala no está disponible';
  END IF;

  -- Mapa de salón: si la sala tiene layout, se reserva un LUGAR puntual.
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
      WHERE clase_id = v_clase_id AND lugar_id = p_lugar_id
        AND status IN ('confirmada','completada')
    ) THEN
      RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elegí otro';
    END IF;
  ELSE
    p_lugar_id := NULL;
  END IF;

  IF v_socio.bloqueado_hasta IS NOT NULL AND v_socio.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: El socio tiene una restricción hasta el %',
      to_char(v_socio.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  -- ── Membresía del socio (las mismas reglas que si reservara él) ────────────
  SELECT m.id, m.status, m.periodo_actual_inicio, m.periodo_actual_fin,
         m.creditos_restantes, t.tipo, t.acceso_todas_sucursales, m.sucursal_id,
         COALESCE(t.invitados_por_periodo, 0)
  INTO v_mem_id, v_mem_status, v_mem_inicio, v_mem_fin,
       v_mem_creditos, v_tier_tipo, v_tier_todas_sedes, v_mem_sucursal,
       v_inv_incluidos
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
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
    RAISE EXCEPTION 'SIN_MEMBRESIA: El socio no tiene una membresía activa';
  END IF;
  IF v_mem_status = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_CONGELADA: La membresía del socio está pausada';
  END IF;
  IF v_mem_fin IS NOT NULL AND v_mem_fin <= v_now THEN
    RAISE EXCEPTION 'MEMBRESIA_VENCIDA: La membresía venció el %',
      to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
  END IF;

  IF v_socio.membresia_tier IS NULL OR
     NOT (v_socio.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
    RAISE EXCEPTION 'TIER_NO_PERMITIDO: El plan del socio no da acceso a esta sala';
  END IF;

  IF NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: El plan del socio solo cubre su sede';
  END IF;

  -- Invitados: misma bolsa por periodo que en la app.
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;

  IF p_invitados > 0 THEN
    IF COALESCE(v_inv_incluidos, 0) = 0 THEN
      RAISE EXCEPTION 'INVITADOS_NO_INCLUIDOS: El plan del socio no incluye pases de invitado';
    END IF;

    v_ventana_inicio := COALESCE(v_mem_inicio, date_trunc('month', v_now));
    v_ventana_fin    := COALESCE(v_mem_fin, v_ventana_inicio + interval '1 month');

    SELECT COALESCE(SUM(r.invitados_count), 0)
    INTO v_inv_usados
    FROM reservas r
    WHERE r.usuario_id = p_usuario_id
      AND r.status IN ('confirmada', 'completada', 'no_show')
      AND r.created_at >= v_ventana_inicio
      AND r.created_at <  v_ventana_fin;

    v_inv_disponibles := GREATEST(v_inv_incluidos - COALESCE(v_inv_usados, 0), 0);

    IF p_invitados > v_inv_disponibles THEN
      RAISE EXCEPTION
        'INVITADOS_EXCEDEN: El plan incluye % pase(s) por periodo y le quedan %',
        v_inv_incluidos, v_inv_disponibles;
    END IF;
  END IF;

  v_costo := 1 + p_invitados;
  IF v_tier_tipo IN ('creditos', 'hibrido')
     AND COALESCE(v_mem_creditos, 0) < v_costo THEN
    RAISE EXCEPTION 'SIN_CREDITOS: Necesita % clase(s) y le quedan %',
      v_costo, COALESCE(v_mem_creditos, 0);
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  -- NO se valida anticipación mínima ni horas continuas: eso es lo que hace
  -- posible el walk-in. El resto de las reglas siguen intactas.

  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = v_clase_id
      AND usuario_id = p_usuario_id
      AND status IN ('confirmada','completada')
  ) THEN
    RAISE EXCEPTION 'YA_RESERVADO: El socio ya tiene una reserva en esta clase';
  END IF;

  -- Cupo = PERSONAS.
  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = v_clase_id
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
    v_tenant_id, v_clase.recurso_id, p_usuario_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo,
    COALESCE(NULLIF(trim(p_notas), ''), 'Walk-in en mostrador'),
    v_clase_id, p_lugar_id
  )
  RETURNING id INTO v_reserva_id;

  IF v_tier_tipo IN ('creditos', 'hibrido') THEN
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
      'reserva ' || v_folio_nuevo || ' (mostrador)'
        || CASE WHEN p_invitados > 0 THEN ' (+' || p_invitados || ' invitado(s))' ELSE '' END,
      v_actor_id
    );
  END IF;

  PERFORM _audrec_log(
    'reserva.crear',
    'reserva',
    v_reserva_id,
    p_usuario_id,
    v_socio.nombre,
    format('Creó una reserva en el mostrador (%s). Motivo: %s',
           v_clase.nombre, COALESCE(NULLIF(trim(p_motivo), ''), 'walk-in')),
    jsonb_build_object(
      'clase_id', v_clase_id,
      'folio', v_folio_nuevo,
      'invitados', p_invitados,
      'motivo', p_motivo
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', v_clase_id,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

REVOKE ALL ON FUNCTION recepcion_crear_reserva(uuid, uuid, uuid, date, integer, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_crear_reserva(uuid, uuid, uuid, date, integer, text, text, text) TO authenticated;

COMMENT ON FUNCTION recepcion_crear_reserva(uuid, uuid, uuid, date, integer, text, text, text) IS
  'Walk-in: recepción reserva EN NOMBRE de un socio. Mantiene todas las reglas (membresía viva, tier con acceso a la sala, sede, cupo, créditos, bolsa de invitados, mapa de salón, doble reserva) y levanta solo la anticipación mínima y el gate de horas continuas, que no aplican en el mostrador. Acepta clase real o virtual (materializa). Audita reserva.crear.';

-- ============================================================================
-- SELF-TEST — devuelve TABLA.
-- ============================================================================
WITH checks AS (
  SELECT 'recepcion_crear_reserva existe (8 args)' AS prueba,
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'recepcion_crear_reserva' AND pronargs = 8) AS ok
  UNION ALL
  SELECT 'exige staff (is_recepcionista)',
         (SELECT pg_get_functiondef(oid) LIKE '%is_recepcionista()%'
            FROM pg_proc WHERE proname = 'recepcion_crear_reserva' LIMIT 1)
  UNION ALL
  SELECT 'NO valida anticipación mínima (permite walk-in)',
         (SELECT pg_get_functiondef(oid) NOT LIKE '%ANTICIPACION_INSUFICIENTE%'
            FROM pg_proc WHERE proname = 'recepcion_crear_reserva' LIMIT 1)
  UNION ALL
  SELECT 'sigue validando cupo, créditos y membresía',
         (SELECT pg_get_functiondef(oid) LIKE '%CUPO_LLENO%'
             AND pg_get_functiondef(oid) LIKE '%SIN_CREDITOS%'
             AND pg_get_functiondef(oid) LIKE '%MEMBRESIA_VENCIDA%'
            FROM pg_proc WHERE proname = 'recepcion_crear_reserva' LIMIT 1)
  UNION ALL
  SELECT 'audita reserva.crear',
         (SELECT pg_get_functiondef(oid) LIKE '%reserva.crear%'
            FROM pg_proc WHERE proname = 'recepcion_crear_reserva' LIMIT 1)
  UNION ALL
  SELECT 'el verbo reserva.crear está permitido en la bitácora',
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'auditoria_recepcion_accion_check'
             AND pg_get_constraintdef(oid) LIKE '%reserva.crear%'
         )
)
SELECT CASE WHEN ok THEN '✅' ELSE '❌' END AS estado, prueba
FROM checks
ORDER BY ok, prueba;
