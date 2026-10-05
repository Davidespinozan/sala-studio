-- POST-W6 · #17A-1 — Reservation Entitlement Provenance (v2, con staff_benefit)
--
-- Contexto: #17 (ghost capacity) encontró que ninguna reserva/entrada a lista de
-- espera guarda qué autorizó realmente esa plaza. #17A-0 descubrió además que
-- admin/recepcionista/staff tienen un self-booking SIN membresía, intencional y
-- documentado desde hace meses (ver comentarios "v_es_socio" en reservar_clase_gate,
-- reserva_dentro_de_vigencia, checkin_valida_membresia) — así que `membresia_id IS
-- NULL` NO puede significar únicamente "legacy": también es, legítimamente, "self-
-- booking de staff, sin membresía de por medio, por diseño".
--
-- Esta migración agrega provenance EXPLÍCITA, persistida en el momento exacto de
-- autorización (nunca reconstruida después):
--   reservas.membresia_id          uuid  REFERENCES membresias(id) ON DELETE RESTRICT
--   reservas.entitlement_source    text  CHECK IN ('membership','staff_benefit','legacy_unknown')
--   lista_espera.membresia_id      (igual)
--   lista_espera.entitlement_source (igual)
--
-- Invariante de consistencia (constraint, no solo convención de código):
--   entitlement_source='membership'     => membresia_id IS NOT NULL
--   entitlement_source='staff_benefit'  => membresia_id IS NULL
--   entitlement_source='legacy_unknown' => membresia_id IS NULL
--
-- Filas existentes: se etiquetan 'legacy_unknown' (membresia_id ya era NULL en
-- todas — no hay backfill, no hay inferencia por fecha/rol/membresía actual).
--
-- Writers actualizados (sin tocar ninguna regla de negocio existente — invitados,
-- tiers, capacidad, créditos, multas, autorización de staff self-booking):
--   reservar_clase_atomic   → 'membership'+v_mem_id (socio) | 'staff_benefit'+NULL (staff)
--   recepcion_crear_reserva → siempre 'membership'+v_mem_id (exige rol='miembro')
--   anotar_lista_espera     → mismo patrón que reservar_clase_atomic
--   _promover_entrada       → COPIA INCONDICIONAL de lista_espera.(membresia_id,
--                             entitlement_source) — nunca recalcula membership ni rol.
--
-- NO se toca: membresia_movimientos (ledger), débitos/refunds/créditos/invitados,
-- ninguna regla de la "staff benefit policy" (queda como deuda de producto aparte),
-- ni #17A-2 (liberación automática — no implementada, ni siquiera diseñada en código).
--
-- Todo-o-nada: si cualquier self-test de otra migración dependiera de la forma
-- previa de estas 4 funciones, fallaría aquí y revertiría toda la migración.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1) SCHEMA — columnas nuevas, nullable primero (se backfillea antes del NOT NULL)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS membresia_id uuid REFERENCES membresias(id) ON DELETE RESTRICT;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS entitlement_source text;

ALTER TABLE lista_espera ADD COLUMN IF NOT EXISTS membresia_id uuid REFERENCES membresias(id) ON DELETE RESTRICT;
ALTER TABLE lista_espera ADD COLUMN IF NOT EXISTS entitlement_source text;

-- ════════════════════════════════════════════════════════════════════════════
-- 2) LEGACY — etiquetar incertidumbre histórica. membresia_id ya era NULL en
--    todas las filas existentes (la columna no existía); no se toca ese valor.
--    Esto es una ETIQUETA explícita de "no sabemos", no una reconstrucción.
-- ════════════════════════════════════════════════════════════════════════════
UPDATE reservas SET entitlement_source = 'legacy_unknown' WHERE entitlement_source IS NULL;
UPDATE lista_espera SET entitlement_source = 'legacy_unknown' WHERE entitlement_source IS NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 3) CONSTRAINTS fail-closed — ya no pueden fallar contra datos existentes
--    porque el paso 2 dejó a toda fila con un valor válido.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE reservas ADD CONSTRAINT reservas_entitlement_source_check
  CHECK (entitlement_source IN ('membership', 'staff_benefit', 'legacy_unknown'));
ALTER TABLE reservas ADD CONSTRAINT reservas_entitlement_source_membresia_consistency CHECK (
  (entitlement_source = 'membership' AND membresia_id IS NOT NULL) OR
  (entitlement_source IN ('staff_benefit', 'legacy_unknown') AND membresia_id IS NULL)
);
ALTER TABLE reservas ALTER COLUMN entitlement_source SET NOT NULL;

ALTER TABLE lista_espera ADD CONSTRAINT lista_espera_entitlement_source_check
  CHECK (entitlement_source IN ('membership', 'staff_benefit', 'legacy_unknown'));
ALTER TABLE lista_espera ADD CONSTRAINT lista_espera_entitlement_source_membresia_consistency CHECK (
  (entitlement_source = 'membership' AND membresia_id IS NOT NULL) OR
  (entitlement_source IN ('staff_benefit', 'legacy_unknown') AND membresia_id IS NULL)
);
ALTER TABLE lista_espera ALTER COLUMN entitlement_source SET NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 4) WRITERS — mismo cuerpo verbatim de cada función, +provenance en el INSERT.
--    Ninguna regla de autorización/negocio existente cambia.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reservar_clase_atomic(
  p_clase_id uuid,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL,
  p_invitados_detalle jsonb DEFAULT NULL
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
  v_min_anticipacion_min integer;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;
  v_existe_doble boolean;
  v_existe_continua boolean;
  v_permitir_continuas boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  v_es_socio boolean;
  v_entitlement_source text;
  v_mem_id uuid;
  v_mem_status text;
  v_mem_inicio timestamptz;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_es_pase boolean;
  v_nuevo_creditos integer;
  v_costo integer;
  v_tier_todas_sedes boolean;
  v_mem_sucursal uuid;

  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;

  v_con_detalle boolean := (p_invitados_detalle IS NOT NULL AND jsonb_array_length(p_invitados_detalle) > 0);
  v_lugares_guest text[];
  v_lugares_todos text[];
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

  -- W2-01: serializa TODA la reserva de ESTA clase (cupo + asientos) para TODAS
  -- las salas — no solo las de mapa. Sin esto, en salas de conteo dos socios
  -- distintos podían leer el mismo SUM y sobrevender el último lugar. Se toma acá,
  -- antes del cálculo de cupo y antes del FOR UPDATE de la membresía (mismo orden
  -- que ya usaban las salas con mapa → sin deadlock).
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || p_clase_id::text));

  -- ── MAPA DE SALÓN ─────────────────────────────────────────────────────────
  IF v_recurso.layout IS NOT NULL THEN
    IF p_lugar_id IS NULL THEN
      RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para esta clase';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l WHERE l->>'id' = p_lugar_id
    ) THEN
      RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
    END IF;

    IF v_con_detalle THEN
      p_invitados := jsonb_array_length(p_invitados_detalle);

      IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_invitados_detalle) e WHERE NULLIF(trim(e->>'nombre'), '') IS NULL) THEN
        RAISE EXCEPTION 'INVITADO_SIN_NOMBRE: Cada invitado necesita un nombre';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_invitados_detalle) e WHERE NULLIF(trim(e->>'lugar_id'), '') IS NULL) THEN
        RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para cada invitado';
      END IF;

      SELECT array_agg(e->>'lugar_id') INTO v_lugares_guest FROM jsonb_array_elements(p_invitados_detalle) e;
      v_lugares_todos := array_append(v_lugares_guest, p_lugar_id);

      IF (SELECT count(*) FROM unnest(v_lugares_todos)) <> (SELECT count(DISTINCT x) FROM unnest(v_lugares_todos) x) THEN
        RAISE EXCEPTION 'LUGAR_DUPLICADO: No repitas el mismo lugar';
      END IF;
      IF EXISTS (
        SELECT 1 FROM unnest(v_lugares_guest) g
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') l WHERE l->>'id' = g)
      ) THEN
        RAISE EXCEPTION 'LUGAR_INVALIDO: Un lugar de invitado no existe en la sala';
      END IF;
      IF EXISTS (
        SELECT 1 FROM reservas
        WHERE clase_id = p_clase_id AND status IN ('confirmada','completada')
          AND lugar_id = ANY(v_lugares_todos)
      ) OR EXISTS (
        SELECT 1 FROM reserva_invitados WHERE clase_id = p_clase_id AND lugar_id = ANY(v_lugares_todos)
      ) THEN
        RAISE EXCEPTION 'LUGAR_OCUPADO: Uno de los lugares ya está tomado, elegí otro';
      END IF;
    ELSE
      IF p_invitados > 0 THEN
        RAISE EXCEPTION 'LUGAR_SIN_INVITADOS: Elegí un lugar para cada invitado';
      END IF;
      IF EXISTS (
        SELECT 1 FROM reservas
        WHERE clase_id = p_clase_id AND lugar_id = p_lugar_id AND status IN ('confirmada','completada')
      ) OR EXISTS (
        SELECT 1 FROM reserva_invitados WHERE clase_id = p_clase_id AND lugar_id = p_lugar_id
      ) THEN
        RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elegí otro';
      END IF;
    END IF;
  ELSE
    p_lugar_id := NULL; -- sala sin mapa: se ignora cualquier lugar (y p_invitados_detalle).
  END IF;

  v_es_socio := v_usuario.rol = 'miembro';
  -- #17A-1: provenance persistida al momento de autorizar, nunca reconstruida después.
  v_entitlement_source := CASE WHEN v_es_socio THEN 'membership' ELSE 'staff_benefit' END;

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
           COALESCE(t.invitados_por_periodo, 0),
           COALESCE(t.es_pase, false)
    INTO v_mem_id, v_mem_status, v_mem_inicio, v_mem_fin,
         v_mem_creditos, v_tier_tipo,
         v_tier_todas_sedes, v_mem_sucursal,
         v_inv_incluidos,
         v_es_pase
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

  IF v_es_socio AND NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: Tu plan solo cubre tu sede';
  END IF;

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

  IF v_es_socio AND NOT COALESCE(v_es_pase, false) AND v_mem_fin IS NOT NULL
     AND (v_slot_inicio AT TIME ZONE v_tz)::date > (v_mem_fin AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'CLASE_FUERA_DE_VIGENCIA: Esa clase es posterior al vencimiento de tu plan (%). Renueva para reservarla.',
      to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
  END IF;

  v_min_anticipacion_min := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_minutos')::integer,
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer * 60,
    (v_tenant.config->>'min_anticipacion_horas')::integer * 60,
    0);
  IF v_slot_inicio < v_now + (v_min_anticipacion_min || ' minutes')::interval THEN
    RAISE EXCEPTION 'ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % minutos de anticipación', v_min_anticipacion_min;
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
    clase_id, lugar_id,
    membresia_id, entitlement_source
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, v_user_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas,
    p_clase_id, p_lugar_id,
    v_mem_id, v_entitlement_source
  )
  RETURNING id INTO v_reserva_id;

  IF v_recurso.layout IS NOT NULL AND v_con_detalle THEN
    INSERT INTO reserva_invitados (tenant_id, reserva_id, clase_id, nombre, telefono, email, lugar_id)
    SELECT v_tenant_id, v_reserva_id, p_clase_id,
           NULLIF(trim(e->>'nombre'), ''), NULLIF(trim(e->>'telefono'), ''),
           NULLIF(trim(e->>'email'), ''), e->>'lugar_id'
    FROM jsonb_array_elements(p_invitados_detalle) e;
  END IF;

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

  -- W2-01: serializa el cupo/asientos de ESTA clase (todas las salas), antes del
  -- check de lugar/cupo y antes del FOR UPDATE de la membresía. Mismo lock y orden
  -- que reservar_clase_atomic → sin deadlock. (Antes esta función no tenía lock.)
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || v_clase_id::text));

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

  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = v_clase_id
      AND usuario_id = p_usuario_id
      AND status IN ('confirmada','completada')
  ) THEN
    RAISE EXCEPTION 'YA_RESERVADO: El socio ya tiene una reserva en esta clase';
  END IF;

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
    clase_id, lugar_id,
    membresia_id, entitlement_source
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, p_usuario_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo,
    COALESCE(NULLIF(trim(p_notas), ''), 'Walk-in en mostrador'),
    v_clase_id, p_lugar_id,
    -- #17A-1: esta ruta exige rol='miembro' con membresía validada más arriba
    -- (ROL_INVALIDO/SIN_MEMBRESIA abortan antes) → siempre 'membership'.
    v_mem_id, 'membership'
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

CREATE OR REPLACE FUNCTION anotar_lista_espera(p_clase_id uuid)
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
  v_tz text;
  v_now timestamptz := now();
  v_slot_inicio timestamptz;
  v_cupos_ocupados integer;
  v_le_id uuid;
  v_le_created timestamptz;
  v_posicion integer;

  -- Rol y gate de membresía (paralelo a reservar_clase_atomic)
  v_es_socio boolean;
  v_entitlement_source text;
  v_mem_id uuid;
  v_mem_status text;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_nuevo_creditos integer;
  v_tier_todas_sedes boolean;  -- Fase 6
  v_mem_sucursal uuid;         -- Fase 6
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;
  SELECT * INTO v_clase FROM clases WHERE id = p_clase_id;

  IF v_clase.id IS NULL OR v_clase.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;
  IF v_clase.status <> 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible';
  END IF;

  -- La clase no debe haber empezado ya — multisede-3: tz de la sucursal.
  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);
  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  IF v_slot_inicio <= v_now THEN
    RAISE EXCEPTION 'CLASE_PASADA: Esta clase ya empezó';
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso.id IS NULL OR NOT v_recurso.activo THEN
    RAISE EXCEPTION 'RECURSO_INACTIVO: Esta sala no está disponible';
  END IF;

  v_es_socio := v_usuario.rol = 'miembro';
  -- #17A-1: misma provenance que reservar_clase_atomic, persistida al entrar.
  v_entitlement_source := CASE WHEN v_es_socio THEN 'membership' ELSE 'staff_benefit' END;

  IF v_usuario.status <> 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa';
  END IF;
  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tenés una restricción activa';
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- GATE de membresía (solo socios). FOR UPDATE serializa el débito.
  -- Paralelo a reservar_clase_atomic — los mismos errores, mismas reglas.
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio THEN
    SELECT m.id, m.status, m.periodo_actual_fin, m.creditos_restantes, t.tipo,
           t.acceso_todas_sucursales, m.sucursal_id                          -- Fase 6
    INTO v_mem_id, v_mem_status, v_mem_fin, v_mem_creditos, v_tier_tipo,
         v_tier_todas_sedes, v_mem_sucursal                                   -- Fase 6
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

    IF v_tier_tipo IN ('creditos', 'hibrido')
       AND COALESCE(v_mem_creditos, 0) <= 0 THEN
      RAISE EXCEPTION 'SIN_CREDITOS: Te quedaste sin créditos en tu paquete';
    END IF;
  END IF;

  -- Tier del recurso (solo socios) — fuera del gate para preservar el orden
  -- existente; los mensajes anteriores se conservan.
  IF v_es_socio THEN
    IF v_usuario.membresia_tier IS NULL OR
       NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
      RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
    END IF;
  END IF;

  -- Fase 6 — alcance por sede: si el plan no da acceso a todas las sedes, la
  -- clase debe ser de la sede a la que el socio se suscribió.
  IF v_es_socio AND NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: Tu plan solo cubre tu sede';
  END IF;

  -- No puede anotarse si ya tiene reserva activa en la clase.
  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = p_clase_id AND usuario_id = v_user_id
      AND status IN ('confirmada', 'completada')
  ) THEN
    RAISE EXCEPTION 'YA_RESERVADO: Ya tenés una reserva en esta clase';
  END IF;

  -- Ni si ya está esperando.
  IF EXISTS (
    SELECT 1 FROM lista_espera
    WHERE clase_id = p_clase_id AND usuario_id = v_user_id AND status = 'esperando'
  ) THEN
    RAISE EXCEPTION 'YA_EN_LISTA: Ya estás en la lista de espera de esta clase';
  END IF;

  -- La clase debe estar LLENA.
  SELECT count(*) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id AND status IN ('confirmada', 'completada');
  IF v_cupos_ocupados < v_clase.cupo_max THEN
    RAISE EXCEPTION 'HAY_CUPO: La clase tiene lugares disponibles, reservá normalmente';
  END IF;

  BEGIN
    INSERT INTO lista_espera (
      tenant_id, clase_id, usuario_id, status,
      membresia_id, entitlement_source
    )
    VALUES (
      v_tenant_id, p_clase_id, v_user_id, 'esperando',
      v_mem_id, v_entitlement_source
    )
    RETURNING id, created_at INTO v_le_id, v_le_created;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'YA_EN_LISTA: Ya estás en la lista de espera de esta clase';
  END;

  SELECT count(*) INTO v_posicion
  FROM lista_espera
  WHERE clase_id = p_clase_id AND status = 'esperando'
    AND (created_at, id) <= (v_le_created, v_le_id);

  -- ───────────────────────────────────────────────────────────────────────
  -- DÉBITO (solo socios con tier creditos/hibrido). Atómico con el INSERT.
  -- Si algo arriba abortó, esto nunca corrió.
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - 1
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, lista_espera_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -1,
      NULL, v_le_id, 'lista_espera ' || v_clase.nombre, v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'lista_espera_id', v_le_id,
    'posicion', v_posicion,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

CREATE OR REPLACE FUNCTION _promover_entrada(p_le_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry lista_espera;
  v_clase clases;
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_folio_count integer;
  v_folio text;
  v_reserva_id uuid;
BEGIN
  SELECT * INTO v_entry FROM lista_espera WHERE id = p_le_id;
  SELECT * INTO v_clase FROM clases WHERE id = v_entry.clase_id;

  -- multisede-3: tz de la sucursal de la clase (fallback a la del tenant).
  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);
  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_clase.tenant_id;
  v_folio := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, clase_id, notas,
    membresia_id, entitlement_source
  ) VALUES (
    v_clase.tenant_id, v_clase.recurso_id, v_entry.usuario_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    0, 'confirmada', v_folio, v_clase.id,
    'Promovido desde lista de espera',
    -- #17A-1: copia INCONDICIONAL de lo que ya se persistió al entrar a la
    -- lista de espera — nunca recalcular membership ni rol en este momento.
    v_entry.membresia_id, v_entry.entitlement_source
  )
  RETURNING id INTO v_reserva_id;

  UPDATE lista_espera
  SET status = 'promovido', promovido_at = now(), reserva_id = v_reserva_id
  WHERE id = p_le_id;

  -- Notificación in-app (el miembro la ve al abrir la app).
  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (
    v_clase.tenant_id, v_entry.usuario_id, 'lista_espera_promovido',
    '¡Se liberó un lugar!',
    'Se liberó un lugar en ' || v_clase.nombre || ' y tu reserva quedó confirmada.',
    jsonb_build_object('clase_id', v_clase.id, 'reserva_id', v_reserva_id)
  );

  RETURN v_reserva_id;
END;
$$;
COMMIT;
