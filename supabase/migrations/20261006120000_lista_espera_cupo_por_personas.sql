-- ════════════════════════════════════════════════════════════════════════════
-- #3 · LISTA DE ESPERA / PISOS DE CUPO CUENTAN PERSONAS (no filas de reserva)
-- ────────────────────────────────────────────────────────────────────────────
-- Problema: la lista de espera y los pisos de cupo medían la ocupación con
-- COUNT(*) de filas de `reservas` contra `clases.cupo_max`. Una reserva con
-- invitados ocupa 1 + invitados_count lugares, y en una sala con mapa el techo
-- real es el número de asientos del layout, no cupo_max. La referencia correcta
-- es reservar_clase_atomic:
--
--   ocupación  = SUM(1 + invitados_count) de reservas confirmada/completada
--   capacidad  = jsonb_array_length(layout->'lugares') si la sala tiene mapa
--                (fallback cupo_max), si no cupo_max
--   lock       = pg_advisory_xact_lock(hashtext('clase_lugares:' || clase_id))
--
-- Consecuencias del bug: (a) anotar_lista_espera decía HAY_CUPO en una clase
-- llena por invitados; (b) una cancelación que liberaba N lugares (reserva con
-- invitados) promovía a UNA sola persona; (c) la promoción podía sobrevender
-- (contaba filas); (d) editar_clase_override / _propagar_cupo_horario dejaban
-- bajar el cupo por debajo de las personas reales.
--
-- Funciones tocadas (exactamente 5; el resto del cuerpo de cada una queda
-- idéntico a su última versión):
--   1. anotar_lista_espera          — "¿está llena?" con SUM/capacidad efectiva.
--   2. promover_siguiente_en_espera — lock de cupo + bucle que RECALCULA la
--                                     ocupación tras cada promoción y llena hasta
--                                     la capacidad real; guarda de entrada vieja.
--   3. promover_manual_lista_espera — mismo lock + fórmula para su chequeo de cupo.
--   4. editar_clase_override        — piso del nuevo cupo_max en personas.
--   5. _propagar_cupo_horario       — piso del GREATEST en personas.
--
-- Fuera de alcance a propósito (rastreados aparte): chequeo de tier con ANY
-- crudo en la lista de espera, guards de tier/bloqueo en la promoción manual,
-- revalidación de entitlement al promover, lock de cancelar_clase, asignación
-- de asiento al promovido (_promover_entrada NO se toca: sigue sin lugar_id).
--
-- CREATE OR REPLACE conserva los GRANT/REVOKE existentes de las 5 funciones.
-- Sin cambios de esquema. Todo-o-nada.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1) anotar_lista_espera — idéntica a 20261005220000 salvo el chequeo de LLENA.
-- ════════════════════════════════════════════════════════════════════════════
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
  v_cupo_efectivo integer;     -- #3
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

  -- La clase debe estar LLENA. #3: personas reales (titular + invitados) contra
  -- la capacidad efectiva (asientos del mapa si la sala tiene layout), con la
  -- misma fórmula que reservar_clase_atomic.
  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id AND status IN ('confirmada', 'completada');
  v_cupo_efectivo := CASE
    WHEN v_recurso.layout IS NOT NULL
      THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
    ELSE v_clase.cupo_max
  END;
  IF v_cupos_ocupados < v_cupo_efectivo THEN
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

-- ════════════════════════════════════════════════════════════════════════════
-- 2) promover_siguiente_en_espera — llena hasta la capacidad REAL.
--
-- Algoritmo:
--   a) lock de cupo de la clase (MISMA llave que reservar_clase_atomic /
--      recepcion_crear_reserva) → serializado contra reservas concurrentes;
--   b) ocupación (personas) y capacidad efectiva frescas; si ya está llena,
--      sale sin efectos (idempotente);
--   c) recorre la cola en el MISMO orden FIFO de siempre; antes de actuar sobre
--      cada entrada re-verifica que SIGA 'esperando' (guarda contra snapshot
--      viejo del cursor);
--   d) las validaciones por candidato y su semántica CONTINUE (saltar, no
--      frenar) son idénticas a la versión anterior (20260613000800);
--   e) tras CADA promoción recalcula ocupación y capacidad desde cero y sigue
--      solo si queda lugar real. Nunca un número fijo de iteraciones.
-- Devuelve el usuario_id del primer promovido (o NULL), como antes devolvía el
-- único promovido. El trigger lo invoca con PERFORM.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION promover_siguiente_en_espera(p_clase_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clase clases;
  v_recurso recursos;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;     -- #3
  v_primero uuid;              -- #3: primer usuario promovido (valor de retorno)
  v_entry lista_espera;
  v_usuario usuarios;
  v_now timestamptz := now();
  -- Devolución (rama defensiva)
  v_mem_id uuid;
  v_tier_tipo text;
  v_debit_count integer;
  v_refund_count integer;
  v_devolver boolean;
BEGIN
  SELECT * INTO v_clase FROM clases WHERE id = p_clase_id;
  -- Clase inexistente o no programada → no se promueve a nadie.
  IF v_clase.id IS NULL OR v_clase.status <> 'programada' THEN
    RETURN NULL;
  END IF;

  -- #3: serializa contra reservas concurrentes de ESTA clase (misma llave y
  -- formato que reservar_clase_atomic).
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || p_clase_id::text));

  -- Lecturas frescas tras el lock.
  SELECT * INTO v_clase FROM clases WHERE id = p_clase_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;

  -- ¿Quedó cupo libre? #3: personas vs capacidad efectiva.
  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada', 'completada');
  v_cupo_efectivo := CASE
    WHEN v_recurso.layout IS NOT NULL
      THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
    ELSE v_clase.cupo_max
  END;
  IF v_cupos_ocupados >= v_cupo_efectivo THEN
    RETURN NULL;
  END IF;

  -- FIFO con lock por fila. SKIP LOCKED: dos cancelaciones concurrentes
  -- bloquean entradas distintas → promueven a personas distintas.
  FOR v_entry IN
    SELECT * FROM lista_espera
    WHERE clase_id = p_clase_id
      AND status = 'esperando'
    ORDER BY created_at ASC, id ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    -- #3: guarda de entrada vieja — el cursor puede traer una foto anterior;
    -- solo se actúa si la entrada SIGUE esperando ahora mismo.
    IF NOT EXISTS (
      SELECT 1 FROM lista_espera WHERE id = v_entry.id AND status = 'esperando'
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_usuario FROM usuarios WHERE id = v_entry.usuario_id;

    -- Saltar entradas no promovibles (la entrada queda 'esperando': si el
    -- usuario se reactiva, sigue en la cola).
    IF v_usuario.status <> 'activo' THEN CONTINUE; END IF;
    IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
      CONTINUE;
    END IF;
    IF v_recurso.id IS NOT NULL
       AND v_usuario.membresia_tier IS NOT NULL
       AND NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
      CONTINUE;
    END IF;

    -- Defensivo: ya tiene reserva activa en la clase → cerrar su entrada y
    -- DEVOLVER el crédito que debitó al anotarse (no va a recibir promoción).
    -- fix M5: antes se cerraba como 'promovido' sin devolver → crédito perdido.
    IF EXISTS (
      SELECT 1 FROM reservas
      WHERE clase_id = p_clase_id
        AND usuario_id = v_entry.usuario_id
        AND status IN ('confirmada', 'completada')
    ) THEN
      v_devolver := false;
      v_mem_id := NULL;

      IF v_usuario.rol = 'miembro' THEN
        SELECT m.id, t.tipo
        INTO v_mem_id, v_tier_tipo
        FROM membresias m
        JOIN tiers t ON t.id = m.tier_id
        WHERE m.usuario_id = v_entry.usuario_id
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
            AND lista_espera_id = v_entry.id
            AND tipo = 'debito';

          SELECT count(*) INTO v_refund_count
          FROM membresia_movimientos
          WHERE membresia_id = v_mem_id
            AND lista_espera_id = v_entry.id
            AND tipo = 'devolucion';

          IF v_debit_count > 0 AND v_refund_count = 0 THEN
            v_devolver := true;
          END IF;
        END IF;
      END IF;

      IF v_devolver THEN
        UPDATE membresias
        SET creditos_restantes = COALESCE(creditos_restantes, 0) + 1
        WHERE id = v_mem_id;

        INSERT INTO membresia_movimientos (
          membresia_id, tenant_id, tipo, delta_creditos,
          reserva_id, lista_espera_id, motivo, created_by
        ) VALUES (
          v_mem_id, v_entry.tenant_id, 'devolucion', 1,
          NULL, v_entry.id,
          'lista de espera: ya tenía reserva (' || COALESCE(v_clase.nombre, '') || ')',
          v_entry.usuario_id
        );
      END IF;

      UPDATE lista_espera
      SET status = 'promovido', promovido_at = v_now
      WHERE id = v_entry.id;
      CONTINUE;
    END IF;

    -- Promover a esta persona.
    PERFORM _promover_entrada(v_entry.id);
    IF v_primero IS NULL THEN
      v_primero := v_entry.usuario_id;
    END IF;

    -- #3: recalcular desde cero (no reusar un número viejo) y seguir solo si
    -- todavía queda lugar real.
    SELECT * INTO v_clase FROM clases WHERE id = p_clase_id;
    SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
    SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
    FROM reservas
    WHERE clase_id = p_clase_id
      AND status IN ('confirmada', 'completada');
    v_cupo_efectivo := CASE
      WHEN v_recurso.layout IS NOT NULL
        THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
      ELSE v_clase.cupo_max
    END;
    EXIT WHEN v_cupos_ocupados >= v_cupo_efectivo;
  END LOOP;

  RETURN v_primero;
END;
$$;

COMMENT ON FUNCTION promover_siguiente_en_espera(uuid) IS
  'Promueve en orden FIFO desde la lista de espera hasta llenar la capacidad real (personas = 1 + invitados; capacidad = asientos del mapa o cupo_max), recalculando tras cada promoción. Toma el lock clase_lugares de la clase (misma llave que reservar_clase_atomic). Salta entradas no promovibles; re-verifica que cada entrada siga esperando. Si el siguiente ya tiene reserva en la clase, cierra su entrada DEVOLVIENDO el crédito (fix M5). Devuelve el primer usuario promovido o NULL.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3) promover_manual_lista_espera — idéntica a 20260520150000 salvo el chequeo
--    de cupo (lock + personas vs capacidad efectiva). Sin guards nuevos.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION promover_manual_lista_espera(p_lista_espera_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_entry lista_espera;
  v_clase clases;
  v_recurso recursos;          -- #3
  v_cupo_efectivo integer;     -- #3
  v_usuario usuarios;
  v_cupos_ocupados integer;
  v_reserva_id uuid;
BEGIN
  v_tenant_id := get_my_tenant_id();
  IF v_tenant_id IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo un administrador puede promover manualmente';
  END IF;

  -- Lock de la entrada para evitar promoción doble (manual + automática).
  SELECT * INTO v_entry FROM lista_espera WHERE id = p_lista_espera_id FOR UPDATE;
  IF v_entry.id IS NULL OR v_entry.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'ENTRADA_NO_EXISTE: Esa entrada de lista de espera no existe';
  END IF;
  IF v_entry.status <> 'esperando' THEN
    RAISE EXCEPTION 'YA_PROCESADA: Esa persona ya no está esperando';
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_entry.clase_id;
  IF v_clase.id IS NULL OR v_clase.status <> 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: La clase no está disponible';
  END IF;

  -- #3: el chequeo de cupo solo es válido si nadie reserva entre la lectura y
  -- el INSERT → mismo lock de cupo que reservar_clase_atomic.
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || v_clase.id::text));

  SELECT * INTO v_clase FROM clases WHERE id = v_entry.clase_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;

  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = v_clase.id AND status IN ('confirmada', 'completada');
  v_cupo_efectivo := CASE
    WHEN v_recurso.layout IS NOT NULL
      THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
    ELSE v_clase.cupo_max
  END;
  IF v_cupos_ocupados >= v_cupo_efectivo THEN
    RAISE EXCEPTION 'CUPO_LLENO: No hay lugar libre. Cancelá una reserva primero.';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_entry.usuario_id;
  IF v_usuario.status <> 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Esa persona ya no tiene una membresía activa';
  END IF;

  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = v_clase.id AND usuario_id = v_entry.usuario_id
      AND status IN ('confirmada', 'completada')
  ) THEN
    RAISE EXCEPTION 'YA_RESERVADO: Esa persona ya tiene una reserva en la clase';
  END IF;

  v_reserva_id := _promover_entrada(v_entry.id);

  RETURN jsonb_build_object('success', true, 'reserva_id', v_reserva_id);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4) editar_clase_override — idéntica a 20260613001700 salvo el piso del cupo,
--    que ahora cuenta PERSONAS (titular + invitados), no filas.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION editar_clase_override(
  p_clase_id uuid DEFAULT NULL,
  p_horario_id uuid DEFAULT NULL,
  p_fecha date DEFAULT NULL,
  p_nombre text DEFAULT NULL,
  p_descripcion text DEFAULT NULL,
  p_cupo_max integer DEFAULT NULL,
  p_duracion_minutos integer DEFAULT NULL,
  p_instructor_id uuid DEFAULT NULL,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_clase_id uuid;
  v_clase clases;
  v_reservados integer;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden editar una clase';
  END IF;

  IF p_clase_id IS NOT NULL THEN
    v_clase_id := p_clase_id;
  ELSIF p_horario_id IS NOT NULL AND p_fecha IS NOT NULL THEN
    v_clase_id := materializar_clase(p_horario_id, p_fecha);
  ELSE
    RAISE EXCEPTION 'PARAMS: se requiere p_clase_id o (p_horario_id, p_fecha)';
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_clase_id;
  IF v_clase.id IS NULL THEN RAISE EXCEPTION 'CLASE_NO_EXISTE: no encontramos esa clase'; END IF;
  IF v_clase.tenant_id <> v_tenant THEN RAISE EXCEPTION 'TENANT_MISMATCH: esa clase no pertenece a tu gimnasio'; END IF;
  IF v_clase.status = 'cancelada' THEN RAISE EXCEPTION 'CLASE_CANCELADA: no se puede editar una clase cancelada'; END IF;

  IF p_duracion_minutos IS NOT NULL AND p_duracion_minutos <= 0 THEN
    RAISE EXCEPTION 'DURACION_INVALIDA: la duración debe ser mayor a 0';
  END IF;

  -- No permitir bajar el cupo por debajo de lo ya reservado.
  -- #3: personas reales (titular + invitados), no filas de reserva.
  IF p_cupo_max IS NOT NULL THEN
    SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_reservados FROM reservas
      WHERE clase_id = v_clase_id AND status IN ('confirmada','completada');
    IF p_cupo_max < v_reservados THEN
      RAISE EXCEPTION 'CUPO_MENOR_QUE_RESERVADOS: ya hay % personas reservadas (con invitados); el cupo no puede ser menor', v_reservados;
    END IF;
    IF p_cupo_max <= 0 THEN
      RAISE EXCEPTION 'CUPO_INVALIDO: el cupo debe ser mayor a 0';
    END IF;
  END IF;

  -- Override: campos editados (COALESCE = solo lo que vino) y, si era una
  -- instancia de regla, se vuelve 'recurrente_modificada' (las 'manual' siguen).
  UPDATE clases
  SET nombre = COALESCE(p_nombre, nombre),
      descripcion = COALESCE(p_descripcion, descripcion),
      cupo_max = COALESCE(p_cupo_max, cupo_max),
      duracion_minutos = COALESCE(p_duracion_minutos, duracion_minutos),
      instructor_id = p_instructor_id,
      origen = CASE WHEN origen = 'recurrente' THEN 'recurrente_modificada' ELSE origen END,
      updated_at = now()
  WHERE id = v_clase_id;

  PERFORM _audrec_log(
    'clase.editar', 'clase', v_clase_id, NULL, NULL,
    format('Editó la clase "%s" del %s.%s',
           COALESCE(p_nombre, v_clase.nombre), v_clase.fecha,
           CASE WHEN NULLIF(trim(COALESCE(p_motivo,'')),'') IS NOT NULL THEN ' Motivo: '||p_motivo ELSE '' END),
    jsonb_build_object('clase_id', v_clase_id, 'fecha', v_clase.fecha, 'motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'clase_id', v_clase_id);
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5) _propagar_cupo_horario — idéntica a 20260808120000 salvo el piso del
--    GREATEST, que ahora cuenta PERSONAS (titular + invitados).
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _propagar_cupo_horario()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo si el cupo REALMENTE cambió (el form puede reenviar el mismo).
  IF NEW.cupo_max IS DISTINCT FROM OLD.cupo_max THEN
    UPDATE clases c
    SET cupo_max = GREATEST(
          -- cupo efectivo nuevo del horario (si NULL, el default de la sala)
          COALESCE(NEW.cupo_max, rd.cupo_max_default),
          -- piso: nunca por debajo de las PERSONAS ya reservadas (#3: + invitados)
          (SELECT COALESCE(SUM(1 + r.invitados_count), 0) FROM reservas r
           WHERE r.clase_id = c.id AND r.status IN ('confirmada','completada'))
        )
    FROM recursos rd
    WHERE c.recurso_id = rd.id
      AND c.horario_recurrente_id = NEW.id
      AND c.fecha >= CURRENT_DATE
      AND c.status <> 'cancelada'
      -- solo las que iban en sincronía con la regla (cupo == efectivo viejo);
      -- las que tienen un cupo distinto son override explícito → se respetan.
      AND c.cupo_max = COALESCE(OLD.cupo_max, rd.cupo_max_default);
  END IF;
  RETURN NEW;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST (devuelve TABLA). Diagnóstico puro: crea un gym desechable, corre
-- los casos y REVIERTE TODO con una excepción centinela antes de devolver las
-- filas (los resultados viven en variables, que no se revierten). No deja
-- residuo; la última fila lo verifica. Se borra a sí mismo al final.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_lista_espera_cupo_personas()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_slug text := 'zz-w3cap-' || substr(md5(random()::text), 1, 6);
  v_p text[] := ARRAY[]::text[];
  v_r text[] := ARRAY[]::text[];
  v_t uuid; v_s uuid; v_rec uuid; v_rec_map uuid;
  a_admin uuid := gen_random_uuid();
  v_u uuid[] := ARRAY[]::uuid[];
  v_c uuid; v_res uuid; v_tmp uuid; v_le uuid[];
  v_err text; v_ocup int; v_cap int; v_n int; v_st text[];
  i int;
BEGIN
  BEGIN
    INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug, 'W3 Cupo', 'gym_libre', 'activo') RETURNING id INTO v_t;
    INSERT INTO sucursales (tenant_id, nombre, orden) VALUES (v_t, 'Sede', 90) RETURNING id INTO v_s;
    INSERT INTO recursos (tenant_id, slug, nombre, sucursal_id, tipo, cupo_max_default)
      VALUES (v_t, 'w3-sala', 'Sala', v_s, 'sala_grupal', 10) RETURNING id INTO v_rec;
    INSERT INTO recursos (tenant_id, slug, nombre, sucursal_id, tipo, cupo_max_default, layout)
      VALUES (v_t, 'w3-mapa', 'Mapa', v_s, 'sala_grupal', 12,
              jsonb_build_object('lugares', (SELECT jsonb_agg(jsonb_build_object('id', 'L'||g)) FROM generate_series(1,10) g)))
      RETURNING id INTO v_rec_map;
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
    VALUES (a_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-ad@sala.dev',
            jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'), '', now(), now(), now());
    UPDATE usuarios SET rol = 'admin', status = 'activo', sucursal_id = v_s WHERE auth_id = a_admin;
    FOR i IN 1..16 LOOP
      INSERT INTO usuarios (tenant_id, email, nombre, rol, status, sucursal_id)
      VALUES (v_t, v_slug||'-u'||i||'@x.dev', 'U'||i, 'miembro', 'activo', v_s) RETURNING id INTO v_res;
      v_u := v_u || v_res;
    END LOOP;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_admin::text)::text, true);

    -- ── T1: 10 personas en 4 filas (3+3+3+1), cupo 10 → anotar ENTRA ──
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_s, CURRENT_DATE + 30, '10:00', 60, 'W3 T1', 10, 'programada') RETURNING id INTO v_c;
    FOR i IN 1..4 LOOP
      INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source)
      VALUES (v_t, v_rec, v_u[i], now() + interval '30 days', now() + interval '30 days 1 hour', 60, CASE WHEN i < 4 THEN 2 ELSE 0 END,
              'confirmada', v_slug||'-t1-'||i, v_c, 'staff_benefit');
    END LOOP;
    v_err := NULL;
    BEGIN PERFORM anotar_lista_espera(v_c); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_p := v_p || 'T1. 10 personas en 4 filas, cupo 10 → anotar lista de espera ENTRA'::text;
    v_r := v_r || CASE WHEN v_err IS NULL THEN '✅ ok' ELSE '❌ err='||v_err END;

    -- ── T2: 9 personas / 10 → HAY_CUPO ──
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_s, CURRENT_DATE + 30, '12:00', 60, 'W3 T2', 10, 'programada') RETURNING id INTO v_c;
    FOR i IN 1..3 LOOP
      INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source)
      VALUES (v_t, v_rec, v_u[i], now() + interval '30 days', now() + interval '30 days 1 hour', 60, 2,
              'confirmada', v_slug||'-t2-'||i, v_c, 'staff_benefit');
    END LOOP;
    v_err := NULL;
    BEGIN PERFORM anotar_lista_espera(v_c); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_p := v_p || 'T2. 9 personas / cupo 10 → HAY_CUPO'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'HAY_CUPO%' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)') END;

    -- ── T3: sala con mapa de 10 asientos, cupo_max 12, 10 personas → ENTRA ──
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec_map, v_s, CURRENT_DATE + 30, '14:00', 60, 'W3 T3', 12, 'programada') RETURNING id INTO v_c;
    FOR i IN 1..10 LOOP
      INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source, lugar_id)
      VALUES (v_t, v_rec_map, v_u[i], now() + interval '30 days', now() + interval '30 days 1 hour', 60, 0,
              'confirmada', v_slug||'-t3-'||i, v_c, 'staff_benefit', 'L'||i);
    END LOOP;
    v_err := NULL;
    BEGIN PERFORM anotar_lista_espera(v_c); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_p := v_p || 'T3. mapa 10 asientos llenos, cupo_max 12 → anotar ENTRA (techo = asientos)'::text;
    v_r := v_r || CASE WHEN v_err IS NULL THEN '✅ ok' ELSE '❌ err='||v_err END;

    -- ── T4: cancelar 1+2 libera 3 lugares; cola A, B(bloqueado), C, D, E ──
    --        → promueve A, C, D; B y E siguen esperando; ocupación 10/10.
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_s, CURRENT_DATE + 30, '16:00', 60, 'W3 T4', 10, 'programada') RETURNING id INTO v_c;
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source)
      VALUES (v_t, v_rec, v_u[1], now() + interval '30 days', now() + interval '30 days 1 hour', 60, 2,
              'confirmada', v_slug||'-t4-x', v_c, 'staff_benefit') RETURNING id INTO v_res;
    FOR i IN 2..8 LOOP
      INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source)
      VALUES (v_t, v_rec, v_u[i], now() + interval '30 days', now() + interval '30 days 1 hour', 60, 0,
              'confirmada', v_slug||'-t4-'||i, v_c, 'staff_benefit');
    END LOOP;
    UPDATE usuarios SET bloqueado_hasta = now() + interval '7 days' WHERE id = v_u[10];
    v_le := ARRAY[]::uuid[];
    FOR i IN 9..13 LOOP
      INSERT INTO lista_espera (tenant_id, clase_id, usuario_id, status, entitlement_source, created_at)
      VALUES (v_t, v_c, v_u[i], 'esperando', 'staff_benefit', now() - interval '1 hour' + (i * interval '1 minute'))
      RETURNING id INTO v_tmp;
      v_le := v_le || v_tmp;
    END LOOP;
    UPDATE reservas SET status = 'cancelada' WHERE id = v_res;
    SELECT array_agg(status ORDER BY created_at) INTO v_st FROM lista_espera WHERE id = ANY(v_le);
    SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_ocup FROM reservas WHERE clase_id = v_c AND status IN ('confirmada','completada');
    v_p := v_p || 'T4. cancelar 1+2 (libera 3) con cola A,B(bloqueado),C,D,E → A,C,D promovidos; B,E esperando; 10/10'::text;
    v_r := v_r || CASE WHEN v_st = ARRAY['promovido','esperando','promovido','promovido','esperando'] AND v_ocup = 10
      THEN '✅ ok' ELSE '❌ estados='||array_to_string(v_st, ',')||' ocupación='||v_ocup END;

    -- ── T5: clase llena → promover no hace nada (dos veces) ──
    PERFORM promover_siguiente_en_espera(v_c);
    PERFORM promover_siguiente_en_espera(v_c);
    SELECT count(*) INTO v_n FROM lista_espera WHERE id = ANY(v_le) AND status = 'promovido';
    SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_ocup FROM reservas WHERE clase_id = v_c AND status IN ('confirmada','completada');
    v_p := v_p || 'T5. clase llena: promover ×2 → 0 efectos (siguen 3 promovidos, 10/10)'::text;
    v_r := v_r || CASE WHEN v_n = 3 AND v_ocup = 10 THEN '✅ ok' ELSE '❌ promovidos='||v_n||' ocupación='||v_ocup END;

    -- ── T6: promoción manual en clase llena → CUPO_LLENO ──
    v_err := NULL;
    BEGIN PERFORM promover_manual_lista_espera(v_le[5]); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_p := v_p || 'T6. promoción manual con 10/10 → CUPO_LLENO'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'CUPO_LLENO%' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)') END;

    -- ── T7: piso de editar_clase_override — 10 personas en 8 filas ──
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_s, CURRENT_DATE + 30, '18:00', 60, 'W3 T7', 12, 'programada') RETURNING id INTO v_c;
    FOR i IN 1..8 LOOP
      INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source)
      VALUES (v_t, v_rec, v_u[i], now() + interval '30 days', now() + interval '30 days 1 hour', 60, CASE WHEN i <= 2 THEN 1 ELSE 0 END,
              'confirmada', v_slug||'-t7-'||i, v_c, 'staff_benefit');
    END LOOP;
    v_err := NULL;
    BEGIN PERFORM editar_clase_override(v_c, NULL, NULL, NULL, NULL, 9, NULL, NULL, 'w3'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT cupo_max INTO v_cap FROM clases WHERE id = v_c;
    v_p := v_p || 'T7a. 10 personas/8 filas: cupo_max → 9 BLOQUEA'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'CUPO_MENOR_QUE_RESERVADOS%' AND v_cap = 12 THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' cupo='||v_cap END;
    v_err := NULL;
    BEGIN PERFORM editar_clase_override(v_c, NULL, NULL, NULL, NULL, 10, NULL, NULL, 'w3'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT cupo_max INTO v_cap FROM clases WHERE id = v_c;
    v_p := v_p || 'T7b. cupo_max → 10 PERMITE'::text;
    v_r := v_r || CASE WHEN v_err IS NULL AND v_cap = 10 THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'-')||' cupo='||v_cap END;

    RAISE EXCEPTION 'W3_DIAG_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'W3_DIAG_ROLLBACK' THEN
      v_p := v_p || 'ERROR inesperado'::text;
      v_r := v_r || ('❌ '||SQLERRM);
    END IF;
  END;

  v_p := v_p || 'Z. sin residuo (todo revertido)'::text;
  v_r := v_r || CASE WHEN NOT EXISTS (SELECT 1 FROM tenants WHERE slug = v_slug)
                      AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = a_admin)
                 THEN '✅ ok' ELSE '❌ quedaron fixtures de '||v_slug END;

  FOR i IN 1..array_length(v_p, 1) LOOP
    prueba := v_p[i]; resultado := v_r[i];
    RETURN NEXT;
  END LOOP;
END $$;

SELECT * FROM _diag_lista_espera_cupo_personas();
DROP FUNCTION _diag_lista_espera_cupo_personas();

COMMIT;
