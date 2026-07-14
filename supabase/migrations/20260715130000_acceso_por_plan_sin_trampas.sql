-- ============================================================================
-- El acceso a las salas se decidía comparando strings sueltos
-- ----------------------------------------------------------------------------
-- `recursos.tiers_permitidos` es un text[] de slugs de planes, SIN llave foránea
-- a `tiers`. Nada garantizaba que esos slugs existieran. Dos agujeros:
--
-- 1) LA LISTA VACÍA SIGNIFICABA LO CONTRARIO EN LA APP Y EN LA BASE.
--    La app trata `tiers_permitidos = {}` como "sala abierta a todos" (así se
--    pinta el badge ABIERTA vs EXCLUSIVA en la landing y en Salas). Pero el gate
--    en SQL era `membresia_tier = ANY(tiers_permitidos)`, y contra un array
--    vacío eso es SIEMPRE falso. O sea: la sala que el dueño dejó sin restringir
--    se anunciaba abierta y después rechazaba a TODO EL MUNDO con
--    TIER_NO_PERMITIDO. El camino natural del admin ("no quiero restringir nada,
--    destildo todos los planes") era una trampa.
--
-- 2) EL ONBOARDING DEJABA LAS SALAS APUNTANDO A LOS PLANES DE EJEMPLO.
--    Un gym nuevo nace con los tiers 'basica' y 'pro' (ejemplos, precio 0) y con
--    sus salas restringidas a ARRAY['basica','pro']. El dueño hace lo obvio:
--    archiva los ejemplos y crea su plan real ("Mensual"). Ahora sus socios
--    tienen membresia_tier = 'mensual' y las salas solo aceptan 'basica'/'pro'.
--    Resultado: NADIE PUEDE RESERVAR, en todas las salas. Y nada se ve roto —
--    los planes están, las salas están, las clases están. El síntoma es mudo.
--    Numa se salvó de casualidad; el gym #2 no.
--
-- La regla, ahora explícita:
--
--   · Lista VACÍA = sala abierta a cualquier plan. (Es lo que la app ya creía.)
--   · Lista CON slugs = solo esos planes. Y la lista solo puede contener slugs
--     de planes ACTIVOS del mismo tenant: lo garantizan triggers, no la buena fe.
--   · Archivar un plan lo saca de las listas. Si una sala se queda sin planes,
--     queda abierta — nunca inalcanzable. Por eso archivar los ejemplos ahora
--     ABRE las salas en vez de trabarlas.
--
-- Las dos RPCs de reserva se recrean para cambiar UNA condición (el gate pasa a
-- llamar al helper). El cuerpo se copió literal del archivo vigente y el diff se
-- verificó línea por línea: es solo el gate. Al final hay un test de contrato que
-- afirma que ninguno de los otros guards se perdió en la copia — que es
-- exactamente el accidente que ya nos pasó dos veces.
-- ============================================================================

-- ── El gate, en un solo lugar ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _sala_permite_tier(p_permitidos text[], p_tier text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    -- Sin lista = sin restricción. La sala es de todos.
    p_permitidos IS NULL
    OR cardinality(p_permitidos) = 0
    -- Con lista: el socio necesita plan, y ese plan tiene que estar en la lista.
    OR (p_tier IS NOT NULL AND p_tier = ANY(p_permitidos));
$$;

REVOKE ALL ON FUNCTION _sala_permite_tier(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _sala_permite_tier(text[], text) TO authenticated;


-- ── 1) reservar_clase_atomic (socio) ────────────────────────────────────────
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
    IF NOT _sala_permite_tier(v_recurso.tiers_permitidos, v_usuario.membresia_tier) THEN
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


-- ── 2) recepcion_crear_reserva (mostrador / agenda del admin) ───────────────
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

  IF NOT _sala_permite_tier(v_recurso.tiers_permitidos, v_socio.membresia_tier) THEN
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

GRANT EXECUTE ON FUNCTION recepcion_crear_reserva(uuid, uuid, uuid, date, integer, text, text, text) TO authenticated;


-- ============================================================================
-- INTEGRIDAD: la lista solo puede tener planes ACTIVOS del mismo tenant
-- ----------------------------------------------------------------------------
-- Sin FK real (es un array), la garantía va por trigger. Filtramos en vez de
-- rechazar: si llega un slug fantasma, se cae solo. Una sala nunca queda
-- restringida a un plan que no existe — que es el estado que dejaba a un gym
-- entero sin poder reservar.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_recursos_tiers_validos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.tiers_permitidos IS NULL OR cardinality(NEW.tiers_permitidos) = 0 THEN
    NEW.tiers_permitidos := ARRAY[]::text[];
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(s ORDER BY s), ARRAY[]::text[])
  INTO NEW.tiers_permitidos
  FROM unnest(NEW.tiers_permitidos) AS s
  WHERE EXISTS (
    SELECT 1 FROM tiers t
    WHERE t.tenant_id = NEW.tenant_id
      AND t.slug = s
      AND t.activo
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recursos_tiers_validos ON recursos;
CREATE TRIGGER recursos_tiers_validos
  BEFORE INSERT OR UPDATE OF tiers_permitidos, tenant_id ON recursos
  FOR EACH ROW
  EXECUTE FUNCTION trg_recursos_tiers_validos();


-- ── Archivar o borrar un plan lo saca de las salas ──────────────────────────
-- Una sala que se queda sin planes queda ABIERTA, no inalcanzable. Este es el
-- trigger que hace que el gym #2 sobreviva: archiva 'basica' y 'pro' (los
-- ejemplos), y sus salas se abren solas en vez de trabarse.
--
-- Efecto lateral asumido: si una sala estaba restringida a un solo plan y ese
-- plan se archiva, la sala pasa a ser abierta. Es la lectura correcta —el gym
-- dejó de vender el único plan que daba acceso—, y el dueño puede volver a
-- restringirla cuando cree el plan nuevo.
CREATE OR REPLACE FUNCTION trg_tier_fuera_de_recursos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- En un DELETE, NEW no existe: nunca hay que tocarlo. Por eso las dos ramas
  -- están separadas en vez de un COALESCE(OLD, NEW) elegante que explotaría.
  IF TG_OP = 'UPDATE' THEN
    -- Solo cuando el plan DEJA de estar disponible (activo → inactivo).
    IF NOT (OLD.activo AND NOT NEW.activo) THEN
      RETURN NEW;
    END IF;
  END IF;

  UPDATE recursos
  SET tiers_permitidos = array_remove(tiers_permitidos, OLD.slug)
  WHERE tenant_id = OLD.tenant_id
    AND OLD.slug = ANY(tiers_permitidos);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tier_archivado_libera_recursos ON tiers;
CREATE TRIGGER tier_archivado_libera_recursos
  AFTER UPDATE OF activo OR DELETE ON tiers
  FOR EACH ROW
  EXECUTE FUNCTION trg_tier_fuera_de_recursos();


-- ============================================================================
-- LIMPIEZA de lo que ya está roto en producción
-- ----------------------------------------------------------------------------
-- Toda sala cuya lista apunta a planes que ya no existen o están archivados.
-- Los slugs fantasma se van. Si no queda ninguno, la sala queda abierta: es lo
-- único que devuelve a esos gyms a un estado operable.
-- ============================================================================
UPDATE recursos r
SET tiers_permitidos = COALESCE(
  (
    SELECT array_agg(s ORDER BY s)
    FROM unnest(r.tiers_permitidos) AS s
    WHERE EXISTS (
      SELECT 1 FROM tiers t
      WHERE t.tenant_id = r.tenant_id AND t.slug = s AND t.activo
    )
  ),
  ARRAY[]::text[]
)
WHERE EXISTS (
  SELECT 1 FROM unnest(r.tiers_permitidos) AS s
  WHERE NOT EXISTS (
    SELECT 1 FROM tiers t
    WHERE t.tenant_id = r.tenant_id AND t.slug = s AND t.activo
  )
);


-- ── El default deja de ser los planes de ejemplo ────────────────────────────
-- Una sala nueva nace ABIERTA. Restringir es una decisión, no un accidente de
-- la semilla.
ALTER TABLE recursos ALTER COLUMN tiers_permitidos SET DEFAULT ARRAY[]::text[];

COMMENT ON COLUMN recursos.tiers_permitidos IS
  'Slugs de planes con acceso a esta sala. VACÍO = abierta a cualquier plan. '
  'Solo puede contener slugs de tiers ACTIVOS del mismo tenant (trigger '
  'recursos_tiers_validos). Archivar un plan lo saca de acá automáticamente.';


-- ── El onboarding deja de sembrar la trampa ─────────────────────────────────
-- La primera sala del gym nace ABIERTA, no atada a 'basica'/'pro'.
--
-- El trigger de archivado ya cubre al dueño que archiva los ejemplos. Pero al
-- que simplemente los IGNORA (los deja ahí y crea su plan al lado) no lo cubre
-- nadie: sus salas seguirían aceptando solo los ejemplos. Por eso hay que sacar
-- la restricción del origen.
UPDATE recursos r
SET tiers_permitidos = ARRAY[]::text[]
WHERE r.tiers_permitidos @> ARRAY['basica', 'pro']
  AND cardinality(r.tiers_permitidos) = 2
  AND EXISTS (
    -- Solo las que quedaron así por la semilla: los dos planes siguen en precio
    -- 0, o sea que el gym nunca los usó de verdad.
    SELECT 1 FROM tiers t
    WHERE t.tenant_id = r.tenant_id
      AND t.slug IN ('basica', 'pro')
      AND t.precio_centavos = 0
    HAVING count(*) = 2
  );


-- ── La función de alta: la primera sala nace abierta ────────────────────────
-- Copiada literal de 20260625100000; el único cambio es la línea de la semilla.
CREATE OR REPLACE FUNCTION crear_tenant_onboarding(
  p_auth_id uuid,
  p_admin_nombre text,
  p_admin_email text,
  p_gym_nombre text,
  p_slug text,
  p_timezone text,
  p_tier_saas text,
  p_moneda text,
  p_precio_centavos integer,
  p_color_primario text,
  p_logo_url text,
  p_sala_nombre text DEFAULT NULL,
  p_sala_cupo integer DEFAULT NULL,
  p_color_acento text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_sucursal_id uuid;
  v_sala_slug text;
  v_fin_trial timestamptz := now() + interval '7 days';
  v_color_acento text := COALESCE(NULLIF(trim(p_color_acento), ''), p_color_primario);
BEGIN
  -- ── 1. Tenant ──
  INSERT INTO tenants (slug, nombre, vertical, branding, config, status)
  VALUES (
    p_slug,
    p_gym_nombre,
    'gym_libre',
    jsonb_build_object(
      'logo_url', p_logo_url,
      'color_primary', p_color_primario,
      'color_bg', '#F5F1E8',
      'color_accent', v_color_acento
    ),
    jsonb_build_object(
      'timezone', p_timezone,
      'reserva', jsonb_build_object(
        'duracion_default_min', 60,
        'anticipacion_min_horas', 0,  -- default permisivo: reservar hasta el inicio (el dueño sube el umbral en Reglas)
        'anticipacion_max_dias', 30,
        'permitir_continuas', false,
        'ventana_check_in_min', 15
      ),
      'membresia', jsonb_build_object(
        'commitment_meses', 0,
        'permite_invitados', true,
        'max_invitados_default', 2
      )
    ),
    'activo'
  )
  RETURNING id INTO v_tenant_id;

  -- ── 1b. Sucursal default del gym nuevo ──
  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden)
  VALUES (v_tenant_id, 'Sucursal Principal', p_timezone, true, 0)
  RETURNING id INTO v_sucursal_id;

  -- ── 2. Usuario admin (vinculado al auth user ya creado) ──
  INSERT INTO usuarios (auth_id, tenant_id, email, nombre, rol, status)
  VALUES (p_auth_id, v_tenant_id, lower(p_admin_email), p_admin_nombre, 'admin', 'activo');

  -- ── 3. Suscripción al SaaS (trial 7 días, pago mock) ──
  INSERT INTO suscripciones_saas (
    tenant_id, tier, moneda, estado,
    trial_termina, periodo_actual_termina, precio_centavos,
    stripe_customer_id, stripe_subscription_id
  )
  VALUES (
    v_tenant_id, p_tier_saas, p_moneda, 'trial',
    v_fin_trial, v_fin_trial, p_precio_centavos,
    'mock_cus_' || substr(md5(random()::text), 1, 10),
    'mock_sub_' || substr(md5(random()::text), 1, 10)
  );

  -- ── 4. Tiers base del gym (basica + pro). ──
  INSERT INTO tiers (tenant_id, slug, nombre, descripcion, precio_centavos, moneda, periodo, activo, orden)
  VALUES
    (v_tenant_id, 'basica', 'Básica',
     'Plan de entrada. Editá el precio y los beneficios desde Planes.',
     0, upper(p_moneda), 'mensual', true, 1),
    (v_tenant_id, 'pro', 'Pro',
     'Plan completo. Editá el precio y los beneficios desde Planes.',
     0, upper(p_moneda), 'mensual', true, 2);

  -- ── 5. Primera sala — OPCIONAL. Sólo si el alta mandó nombre de sala.
  --        Si no, el gym nace sin salas y el dueño crea las que necesite
  --        desde /admin/recursos (ChecklistActivacion lo guía).
  IF p_sala_nombre IS NOT NULL AND trim(p_sala_nombre) <> '' THEN
    v_sala_slug := COALESCE(
      NULLIF(trim(both '-' from lower(regexp_replace(p_sala_nombre, '[^a-z0-9]+', '-', 'gi'))), ''),
      'sala-1'
    );
    INSERT INTO recursos (
      tenant_id, sucursal_id, slug, nombre, tipo, cupos, cupo_max_default,
      tiers_permitidos, activo, orden
    )
    VALUES (
      v_tenant_id, v_sucursal_id, v_sala_slug, trim(p_sala_nombre), 'sala_grupal',
      COALESCE(p_sala_cupo, 15), COALESCE(p_sala_cupo, 15),
      ARRAY[]::text[], true, 1  -- sala ABIERTA: restringir es una decisión, no la semilla
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'tenant_id', v_tenant_id, 'slug', p_slug);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'SLUG_TOMADO: El subdominio "%" ya está en uso', p_slug;
END;
$$;


-- ============================================================================
-- TEST DE CONTRATO: recrear una función grande NO puede perder sus guards.
-- ----------------------------------------------------------------------------
-- Ya nos pasó dos veces (el guard de sucursal en el check-in, el techo de
-- invitados). Acá afirmamos que cada RPC recreada sigue conteniendo TODOS los
-- códigos de error que tenía. Si una copia perdió uno, esta migración explota
-- acá y no en producción, seis semanas después, con un socio que no puede entrar.
-- ============================================================================
DO $$
DECLARE
  v_src text;
  v_codigo text;
  v_faltan text[] := ARRAY[]::text[];

  c_reservar text[] := ARRAY[
    'NO_AUTH', 'CLASE_NO_EXISTE', 'CLASE_NO_PROGRAMADA', 'RECURSO_NO_EXISTE',
    'RECURSO_INACTIVO', 'LUGAR_SIN_INVITADOS', 'LUGAR_REQUERIDO', 'LUGAR_INVALIDO',
    'LUGAR_OCUPADO', 'USUARIO_INACTIVO', 'USUARIO_BLOQUEADO', 'SIN_MEMBRESIA',
    'MEMBRESIA_CONGELADA', 'MEMBRESIA_VENCIDA', 'SIN_CREDITOS', 'TIER_NO_PERMITIDO',
    'SUCURSAL_NO_INCLUIDA', 'INVITADOS_INVALIDOS', 'CUPO_LLENO', 'YA_RESERVADO'
  ];
  c_recepcion text[] := ARRAY[
    'NO_AUTH', 'NO_AUTORIZADO', 'USUARIO_NO_EXISTE', 'ROL_INVALIDO',
    'CLASE_REQUERIDA', 'CLASE_NO_EXISTE', 'CLASE_NO_PROGRAMADA', 'RECURSO_INACTIVO',
    'USUARIO_BLOQUEADO', 'SIN_MEMBRESIA', 'MEMBRESIA_CONGELADA', 'MEMBRESIA_VENCIDA',
    'SIN_CREDITOS', 'TIER_NO_PERMITIDO', 'SUCURSAL_NO_INCLUIDA', 'CUPO_LLENO',
    'YA_RESERVADO', 'INVITADOS_INVALIDOS', 'INVITADOS_NO_INCLUIDOS',
    'LUGAR_SIN_INVITADOS', 'LUGAR_REQUERIDO', 'LUGAR_INVALIDO', 'LUGAR_OCUPADO'
  ];
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'reservar_clase_atomic';
  FOREACH v_codigo IN ARRAY c_reservar LOOP
    IF position(v_codigo IN v_src) = 0 THEN
      v_faltan := array_append(v_faltan, 'reservar_clase_atomic:' || v_codigo);
    END IF;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'recepcion_crear_reserva';
  FOREACH v_codigo IN ARRAY c_recepcion LOOP
    IF position(v_codigo IN v_src) = 0 THEN
      v_faltan := array_append(v_faltan, 'recepcion_crear_reserva:' || v_codigo);
    END IF;
  END LOOP;

  IF cardinality(v_faltan) > 0 THEN
    RAISE EXCEPTION 'GUARD_PERDIDO en la recreación: %', array_to_string(v_faltan, ', ');
  END IF;
END;
$$;


-- ============================================================================
-- SELF-TEST (devuelve tabla: el editor esconde los NOTICE)
-- ============================================================================
SELECT 'sala abierta acepta cualquier plan' AS prueba,
       'true' AS espera,
       _sala_permite_tier(ARRAY[]::text[], 'lo-que-sea')::text AS resultado
UNION ALL
SELECT 'sala abierta acepta socio sin plan (lo frena el gate de membresía, no este)',
       'true', _sala_permite_tier(ARRAY[]::text[], NULL)::text
UNION ALL
SELECT 'sala restringida acepta al plan de la lista',
       'true', _sala_permite_tier(ARRAY['mensual','anual'], 'mensual')::text
UNION ALL
SELECT 'sala restringida rechaza al plan de afuera',
       'false', _sala_permite_tier(ARRAY['mensual'], 'anual')::text
UNION ALL
SELECT 'sala restringida rechaza al socio sin plan',
       'false', _sala_permite_tier(ARRAY['mensual'], NULL)::text
UNION ALL
SELECT 'ninguna sala quedó apuntando a un plan que no existe',
       '0 salas',
       count(*)::text || ' salas'
FROM recursos r
WHERE EXISTS (
  SELECT 1 FROM unnest(r.tiers_permitidos) AS s
  WHERE NOT EXISTS (
    SELECT 1 FROM tiers t
    WHERE t.tenant_id = r.tenant_id AND t.slug = s AND t.activo
  )
)
UNION ALL
SELECT 'salas que la limpieza dejó ABIERTAS (revisá si alguna debía ser exclusiva)',
       'informativo',
       count(*)::text || ' salas: ' || COALESCE(string_agg(r.nombre, ', '), '—')
FROM recursos r
WHERE cardinality(r.tiers_permitidos) = 0 AND r.activo;
