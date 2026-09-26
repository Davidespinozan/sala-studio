-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ════════════════════════════════════════════════════════════════════════════
-- INVITADOS CON LUGAR en salas con Mapa de Salón
-- ----------------------------------------------------------------------------
-- Hoy en salas con mapa se bloquean invitados (LUGAR_SIN_INVITADOS). Se permite que
-- un socio con invitados incluidos elija SU lugar + un lugar por cada invitado; cada
-- invitado ocupa un asiento real. El asiento del titular vive en reservas.lugar_id;
-- los de invitados en reserva_invitados.lugar_id (+ clase_id para unicidad).
--
-- El RPC recibe p_invitados_detalle jsonb = [{nombre, telefono, email, lugar_id}] y,
-- para salas con mapa, valida e INSERTA las identidades de invitados DENTRO del RPC
-- (atómico con el asiento). En salas sin mapa se ignora (el front sigue igual).
--
-- Overload: agregar un parámetro crearía ambigüedad con la firma vieja, así que se
-- DROP + CREATE la familia en orden de dependencias.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Esquema: lugar (y clase) por invitado + unicidad de asiento entre invitados.
ALTER TABLE reserva_invitados ADD COLUMN IF NOT EXISTS lugar_id text;
ALTER TABLE reserva_invitados ADD COLUMN IF NOT EXISTS clase_id uuid REFERENCES clases(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS reserva_invitados_lugar_unico
  ON reserva_invitados (clase_id, lugar_id)
  WHERE lugar_id IS NOT NULL;

-- 2) DROP en orden (wrappers → virtual → atomic).
DROP FUNCTION IF EXISTS reservar_clase_virtual_con_multa(uuid, date, integer, text, text);
DROP FUNCTION IF EXISTS reservar_clase_atomic_con_multa(uuid, integer, text, text);
DROP FUNCTION IF EXISTS reservar_clase_virtual(uuid, date, integer, text, text);
DROP FUNCTION IF EXISTS reservar_clase_atomic(uuid, integer, text, text);

-- 3) reservar_clase_atomic (+ p_invitados_detalle). Cuerpo = 20260923130000 con la
--    rama MAPA extendida para invitados-con-lugar y el INSERT de reserva_invitados.
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

  -- Rol y gate de membresía
  v_es_socio boolean;
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

  -- Invitados por periodo
  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;

  -- Invitados con lugar (mapa)
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

  -- ── MAPA DE SALÓN ─────────────────────────────────────────────────────────
  IF v_recurso.layout IS NOT NULL THEN
    -- Serializa la asignación de lugares de ESTA clase (evita carreras que cruzan
    -- reservas.lugar_id + reserva_invitados.lugar_id).
    PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || p_clase_id::text));

    IF p_lugar_id IS NULL THEN
      RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para esta clase';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l WHERE l->>'id' = p_lugar_id
    ) THEN
      RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
    END IF;

    -- Invitados con lugar: derivar cantidad y validar sus asientos.
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

      -- Sin lugares repetidos entre titular + invitados de esta misma reserva.
      IF (SELECT count(*) FROM unnest(v_lugares_todos)) <> (SELECT count(DISTINCT x) FROM unnest(v_lugares_todos) x) THEN
        RAISE EXCEPTION 'LUGAR_DUPLICADO: No repitas el mismo lugar';
      END IF;
      -- Cada lugar de invitado existe en el layout.
      IF EXISTS (
        SELECT 1 FROM unnest(v_lugares_guest) g
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') l WHERE l->>'id' = g)
      ) THEN
        RAISE EXCEPTION 'LUGAR_INVALIDO: Un lugar de invitado no existe en la sala';
      END IF;
      -- Ningún lugar (titular ni invitados) puede estar ya tomado.
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
      -- Sin detalle: no se permiten invitados en mapa (cada persona su lugar).
      IF p_invitados > 0 THEN
        RAISE EXCEPTION 'LUGAR_SIN_INVITADOS: Elegí un lugar para cada invitado';
      END IF;
      -- Titular: su lugar no debe estar tomado (por otra reserva o por un invitado).
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

  -- VIGENCIA: no reservar una clase posterior al vencimiento (excepto day pass).
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

  -- Invitados CON LUGAR (mapa): identidades + asiento, atómico con la reserva.
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

REVOKE ALL ON FUNCTION reservar_clase_atomic(uuid, integer, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservar_clase_atomic(uuid, integer, text, text, jsonb) TO authenticated;

-- 4) virtual: materializa y delega (pasa el detalle).
CREATE OR REPLACE FUNCTION reservar_clase_virtual(
  p_horario_id uuid,
  p_fecha date,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL,
  p_invitados_detalle jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_clase_id uuid;
BEGIN
  v_clase_id := materializar_clase(p_horario_id, p_fecha);
  RETURN reservar_clase_atomic(v_clase_id, p_invitados, p_notas, p_lugar_id, p_invitados_detalle);
END $$;

REVOKE ALL ON FUNCTION reservar_clase_virtual(uuid, date, integer, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservar_clase_virtual(uuid, date, integer, text, text, jsonb) TO authenticated;

-- 5) wrappers _con_multa (pasan el detalle).
CREATE OR REPLACE FUNCTION reservar_clase_atomic_con_multa(
  p_clase_id uuid,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL,
  p_invitados_detalle jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_res jsonb; v_multa int;
BEGIN
  PERFORM set_config('sala.acepta_multa', 'on', true);
  v_res := reservar_clase_atomic(p_clase_id, p_invitados, p_notas, p_lugar_id, p_invitados_detalle);
  SELECT multa_centavos INTO v_multa FROM reservas WHERE id = (v_res->>'reserva_id')::uuid;
  RETURN v_res || jsonb_build_object('multa_centavos', COALESCE(v_multa, 0));
END; $$;

REVOKE ALL ON FUNCTION reservar_clase_atomic_con_multa(uuid, integer, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservar_clase_atomic_con_multa(uuid, integer, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION reservar_clase_virtual_con_multa(
  p_horario_id uuid,
  p_fecha date,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL,
  p_invitados_detalle jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_res jsonb; v_multa int;
BEGIN
  PERFORM set_config('sala.acepta_multa', 'on', true);
  v_res := reservar_clase_virtual(p_horario_id, p_fecha, p_invitados, p_notas, p_lugar_id, p_invitados_detalle);
  SELECT multa_centavos INTO v_multa FROM reservas WHERE id = (v_res->>'reserva_id')::uuid;
  RETURN v_res || jsonb_build_object('multa_centavos', COALESCE(v_multa, 0));
END; $$;

REVOKE ALL ON FUNCTION reservar_clase_virtual_con_multa(uuid, date, integer, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservar_clase_virtual_con_multa(uuid, date, integer, text, text, jsonb) TO authenticated;

-- 6) lugares_ocupados: UNION del asiento del titular + los de invitados.
CREATE OR REPLACE FUNCTION lugares_ocupados(p_clase_id uuid)
RETURNS TABLE(lugar_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.lugar_id
  FROM reservas r
  JOIN clases c ON c.id = r.clase_id
  WHERE r.clase_id = p_clase_id
    AND r.status IN ('confirmada','completada')
    AND r.lugar_id IS NOT NULL
    AND c.tenant_id = get_my_tenant_id()
  UNION
  SELECT ri.lugar_id
  FROM reserva_invitados ri
  JOIN clases c ON c.id = ri.clase_id
  WHERE ri.clase_id = p_clase_id
    AND ri.lugar_id IS NOT NULL
    AND c.tenant_id = get_my_tenant_id();
$$;

REVOKE ALL ON FUNCTION lugares_ocupados(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION lugares_ocupados(uuid) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST — DEVUELVE TABLA (verifica firma nueva + esquema; el flujo con JWT se
-- prueba en la app).
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'invitados con lugar (mapa)' AS prueba,
  EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='reserva_invitados' AND column_name='lugar_id')            AS col_lugar_ok,
  EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='reserva_invitados' AND column_name='clase_id')            AS col_clase_ok,
  pg_get_functiondef('reservar_clase_atomic(uuid, integer, text, text, jsonb)'::regprocedure)
    ILIKE '%p_invitados_detalle%'                                              AS rpc_param_ok,
  has_function_privilege('authenticated',
    'reservar_clase_atomic(uuid, integer, text, text, jsonb)', 'EXECUTE')       AS grant_ok;
