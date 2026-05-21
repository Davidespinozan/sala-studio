-- ============================================================================
-- Multi-sucursal Nivel 1 — multisede-3: timezone POR SUCURSAL
-- ============================================================================
-- Hasta S4.4 la timezone vivía en tenants.config.timezone: un tenant = una tz.
-- Con multi-sucursal, cada SUCURSAL tiene su propia tz (sucursales.timezone, ya
-- existe desde multisede-1) — una cadena puede tener sedes en distintas zonas.
--
-- Una clase NO guarda un instante absoluto: guarda fecha (date) + hora_inicio
-- (time), o sea "wall-clock" de su sucursal. La timezone se necesita en dos
-- momentos:
--   1. GENERAR clases  → para calcular "hoy" (inicio de la ventana de 60 días).
--   2. RESERVAR/lista de espera → para convertir fecha+hora a un instante
--      timestamptz real (reservas.slot_inicio / slot_fin, chequeo de
--      anticipación, "clase ya empezó").
-- Antes de multisede-3 ambos usaban tenants.config.timezone. Ahora usan la tz
-- de la sucursal de la clase/horario.
--
-- QUÉ REESCRIBE ESTA MIGRACIÓN (solo CREATE OR REPLACE — firmas idénticas, los
-- GRANT existentes se preservan; el cron y el front no cambian de contrato):
--   A) timezone_de_sucursal()    — helper nuevo: tz de una sucursal con
--                                   fallback a la del tenant.
--   B) generar_clases_recurrentes — "hoy" por sucursal; cada clase se crea en
--                                   la sucursal de su horario (sucursal_id).
--   C) reservar_clase_atomic      — convierte fecha+hora con la tz de la
--                                   sucursal de la clase.
--   D) _promover_entrada          — idem, al promover desde lista de espera.
--   E) anotar_lista_espera        — idem, para el chequeo "clase ya empezó".
--
-- CLASES YA EXISTENTES — NO se tocan:
--   multisede-1 ya asignó sucursal_id a TODAS las clases viejas (la "Sucursal
--   Principal" de su tenant) y esa sucursal heredó la tz del tenant. O sea: el
--   wall-clock de las clases viejas ya es coherente con la tz de su sucursal.
--   Esta migración NO borra, NO regenera y NO modifica ninguna fila de `clases`
--   ni de `reservas` — solo redefine funciones. Cero riesgo de duplicar clases
--   (la generación es idempotente: ON CONFLICT DO NOTHING) o de perder reservas.
--
-- EL CRON NIGHTLY sigue igual: la Edge Function regenerar-clases llama una vez
-- por tenant a generar_clases_recurrentes(tenant, 60); esa función ahora cubre
-- TODAS las sucursales del tenant en esa misma llamada.
-- ============================================================================

-- ============================================================================
-- A) HELPER — timezone_de_sucursal(sucursal_id, tenant_id)
-- ============================================================================
-- Devuelve la tz de la sucursal. Fallbacks defensivos: si la sucursal no
-- existe o tiene la tz vacía → tz del tenant; si tampoco → America/Mexico_City.
-- (sucursales.timezone es NOT NULL DEFAULT, así que el fallback casi nunca
-- aplica — está por robustez.)
-- ============================================================================

CREATE OR REPLACE FUNCTION timezone_de_sucursal(
  p_sucursal_id uuid,
  p_tenant_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF((SELECT s.timezone FROM sucursales s WHERE s.id = p_sucursal_id), ''),
    NULLIF((SELECT t.config->>'timezone' FROM tenants t WHERE t.id = p_tenant_id), ''),
    'America/Mexico_City'
  );
$$;

REVOKE ALL ON FUNCTION timezone_de_sucursal(uuid, uuid) FROM PUBLIC;

COMMENT ON FUNCTION timezone_de_sucursal(uuid, uuid) IS
  'multisede-3: tz IANA efectiva de una sucursal (sucursales.timezone), con fallback a tenants.config.timezone y luego America/Mexico_City.';

-- ============================================================================
-- B) generar_clases_recurrentes — generación per-sucursal
-- ============================================================================
-- Cambios vs. la versión S5:
--   - Cada horario_recurrente se une a su sucursal; "hoy" (inicio de la ventana)
--     se calcula en la tz de ESA sucursal — el generate_series es LATERAL, se
--     evalúa por fila.
--   - La clase nueva hereda sucursal_id del horario (hr.sucursal_id).
--   - Se saltean las sucursales inactivas (s.activa = false): una sede apagada
--     no debe acumular clases nuevas.
-- Firma idéntica (uuid, integer) → el cron y el wrapper "generar ahora" siguen
-- funcionando sin cambios. Idempotente: ON CONFLICT DO NOTHING.
-- ============================================================================

CREATE OR REPLACE FUNCTION generar_clases_recurrentes(
  p_tenant_id uuid,
  p_dias_forward integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clases_creadas integer := 0;
  v_tenant_tz text;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id no puede ser NULL';
  END IF;
  IF p_dias_forward < 1 OR p_dias_forward > 365 THEN
    RAISE EXCEPTION 'p_dias_forward fuera de rango razonable [1, 365]: %', p_dias_forward;
  END IF;

  -- tz del tenant: default para sucursales que no tuvieran tz propia.
  SELECT COALESCE(config->>'timezone', 'America/Mexico_City')
    INTO v_tenant_tz
    FROM tenants
    WHERE id = p_tenant_id;

  IF v_tenant_tz IS NULL THEN
    RAISE EXCEPTION 'Tenant % no existe', p_tenant_id;
  END IF;

  -- Cada horario pertenece a una sucursal. "Hoy" se calcula en la tz de esa
  -- sucursal (el generate_series LATERAL se evalúa por fila).
  INSERT INTO clases (
    tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos,
    nombre, disciplina, cupo_max, instructor_id, origen,
    horario_recurrente_id, status
  )
  SELECT
    hr.tenant_id,
    hr.sucursal_id,
    hr.recurso_id,
    f.fecha,
    hr.hora_inicio,
    hr.duracion_minutos,
    hr.nombre,
    r.tipo_contenido[1],
    COALESCE(hr.cupo_max, r.cupo_max_default),
    hr.instructor_id,
    'recurrente',
    hr.id,
    'programada'
  FROM horarios_recurrentes hr
  JOIN recursos   r ON r.id = hr.recurso_id
  JOIN sucursales s ON s.id = hr.sucursal_id
  CROSS JOIN LATERAL (
    SELECT gs::date AS fecha
    FROM generate_series(
      (now() AT TIME ZONE COALESCE(NULLIF(s.timezone, ''), v_tenant_tz))::date,
      (now() AT TIME ZONE COALESCE(NULLIF(s.timezone, ''), v_tenant_tz))::date
        + (p_dias_forward || ' days')::interval,
      '1 day'::interval
    ) AS gs
  ) f
  WHERE hr.tenant_id = p_tenant_id
    AND hr.activo = true
    AND r.activo = true
    AND s.activa = true
    AND EXTRACT(DOW FROM f.fecha)::int = ANY(hr.dias_semana)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_clases_creadas = ROW_COUNT;

  RETURN jsonb_build_object(
    'clases_creadas', v_clases_creadas,
    'tenant_id', p_tenant_id,
    'tenant_timezone', v_tenant_tz,
    'dias_forward', p_dias_forward,
    'ts', now()
  );
END $$;

COMMENT ON FUNCTION generar_clases_recurrentes(uuid, integer) IS
  'multisede-3: genera clases desde horarios_recurrentes. Cada clase hereda la sucursal de su horario; "hoy" se calcula en la tz de esa sucursal. Cubre todas las sucursales activas del tenant. Idempotente (ON CONFLICT DO NOTHING). La invoca el cron nightly regenerar-clases.';

-- ============================================================================
-- C) reservar_clase_atomic — convierte fecha+hora con la tz de la sucursal
-- ============================================================================
-- Único cambio funcional vs. S4.4: v_tz pasa de la tz del tenant a la tz de la
-- sucursal de la clase (timezone_de_sucursal). Así reservas.slot_inicio /
-- slot_fin y el chequeo de anticipación quedan en el instante real correcto.
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

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_usuario.membresia_tier IS NULL OR
     NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
    RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
  END IF;

  v_max_invitados := max_invitados_por_tier(v_usuario.membresia_tier);
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  v_min_anticipacion_h := COALESCE((v_tenant.config->>'min_anticipacion_horas')::integer, 24);
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
  v_folio_nuevo := 'EKK-' || lpad((v_folio_count + 1)::text, 6, '0');

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

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', p_clase_id
  );
END;
$$;

COMMENT ON FUNCTION reservar_clase_atomic(uuid, integer, text) IS
  'multisede-3: reserva una clase por clase_id. Convierte fecha+hora con la timezone de la SUCURSAL de la clase (timezone_de_sucursal). No valida acceso por sucursal (eso es Nivel 2).';

-- ============================================================================
-- D) _promover_entrada — lista de espera: instante con la tz de la sucursal
-- ============================================================================
-- Helper interno (lista de espera). Único cambio vs. la versión original:
-- v_tz pasa de la tz del tenant a la tz de la sucursal de la clase. v_tenant
-- ya no se necesita.
-- ============================================================================

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
  v_folio := 'EKK-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, clase_id, notas
  ) VALUES (
    v_clase.tenant_id, v_clase.recurso_id, v_entry.usuario_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    0, 'confirmada', v_folio, v_clase.id,
    'Promovido desde lista de espera'
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

COMMENT ON FUNCTION _promover_entrada(uuid) IS
  'Helper interno (lista de espera): crea la reserva confirmada de una entrada, la marca promovido y notifica. multisede-3: convierte fecha+hora con la tz de la sucursal de la clase. No invocable por clientes.';

-- ============================================================================
-- E) anotar_lista_espera — chequeo "clase ya empezó" con la tz de la sucursal
-- ============================================================================
-- Único cambio vs. la versión original: v_tz pasa de la tz del tenant a la tz
-- de la sucursal de la clase. v_tenant ya no se necesita.
-- ============================================================================

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

  IF v_usuario.status <> 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa';
  END IF;
  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tenés una restricción activa';
  END IF;
  IF v_usuario.membresia_tier IS NULL OR
     NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
    RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
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

  -- La clase debe estar LLENA: si hay cupo, debe reservar normalmente.
  SELECT count(*) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id AND status IN ('confirmada', 'completada');
  IF v_cupos_ocupados < v_clase.cupo_max THEN
    RAISE EXCEPTION 'HAY_CUPO: La clase tiene lugares disponibles, reservá normalmente';
  END IF;

  BEGIN
    INSERT INTO lista_espera (tenant_id, clase_id, usuario_id, status)
    VALUES (v_tenant_id, p_clase_id, v_user_id, 'esperando')
    RETURNING id, created_at INTO v_le_id, v_le_created;
  EXCEPTION WHEN unique_violation THEN
    -- Race: dos anotar concurrentes pasaron el EXISTS. El índice parcial gana.
    RAISE EXCEPTION 'YA_EN_LISTA: Ya estás en la lista de espera de esta clase';
  END;

  SELECT count(*) INTO v_posicion
  FROM lista_espera
  WHERE clase_id = p_clase_id AND status = 'esperando'
    AND (created_at, id) <= (v_le_created, v_le_id);

  RETURN jsonb_build_object(
    'success', true,
    'lista_espera_id', v_le_id,
    'posicion', v_posicion
  );
END;
$$;

COMMENT ON FUNCTION anotar_lista_espera(uuid) IS
  'El miembro se anota en la lista de espera de una clase llena. multisede-3: el chequeo "clase ya empezó" usa la tz de la sucursal de la clase. Devuelve { success, lista_espera_id, posicion }.';

-- ============================================================================
-- F) VERIFICACIÓN
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'multisede-3 OK: timezone_de_sucursal + generar_clases_recurrentes (per-sucursal) + reservar_clase_atomic + _promover_entrada + anotar_lista_espera reescritas. Ninguna fila de clases/reservas modificada.';
END $$;
