-- ============================================================================
-- D-011 — Lista de espera debita/devuelve crédito (cierra el agujero de saldo)
-- ============================================================================
-- BUG ORIGINAL — la lista de espera era el último flujo donde el saldo de
-- créditos quedaba descuadrado. CINCO agujeros conocidos:
--
--   1. Socio se anota en lista (`anotar_lista_espera`) → NO debita.
--      Cuando se libera lugar y `_promover_entrada` lo asciende, queda con
--      reserva confirmada SIN haber consumido crédito. Crédito regalado.
--
--   2. Socio sale de la lista (`salir_lista_espera`) → como nunca debitó, no
--      hay nada que devolver. OK.
--      Pero si en (1) hubiera debitado al anotarse, salir SIN devolver sería
--      pérdida silenciosa.
--
--   3. Admin cancela la clase entera → `trg_limpiar_espera_clase_cancelada`
--      marca todas las entradas 'cancelado' y se acabó. Si hubieran debitado
--      al anotarse, los socios pierden el crédito sin culpa.
--
--   4. Clase pasa de hora y nadie promovió al socio en espera → la entrada
--      queda 'esperando' indefinidamente. No es solo cosmético: si la entrada
--      había debitado, el saldo nunca se devuelve.
--
--   5. Socio promovido cancela su nueva reserva A TIEMPO → la reserva creada
--      por `_promover_entrada` no tiene movimiento 'debito' propio (el débito
--      original está atado a la entrada de lista_espera, no a la reserva).
--      `cancelar_reserva_atomic` busca por reserva_id, no encuentra → no
--      devuelve. El SOCIO pierde el crédito que pagó al anotarse + cancela en
--      regla. PEOR que el gym regalando: acá pierde el cliente.
--
-- DECISIÓN (Opción 1 + (c) confirmadas) — débito en `anotar_lista_espera`,
-- mismo patrón que `reservar_clase_atomic`. La lógica de promoción NO se toca:
-- `_promover_entrada` sigue creando la reserva sin debitar (el socio ya pagó
-- al anotarse). Toda salida posible de la entrada debe devolver:
--   - salir_lista_espera         → refund (si había debitado y no se devolvió)
--   - clase cancelada por admin  → refund (vía trigger amplificado)
--   - expiración por slot pasado → refund (nueva function + cron)
--   - reserva promovida cancelada → refund (cancelar_reserva_atomic con
--     fallback al origen lista_espera; ver sección H)
--
-- DESCARTADO — re-vincular el débito (UPDATE membresia_movimientos.reserva_id
-- al promover) viola el ledger inmutable (trg_membresia_mov_no_update). El
-- patrón append-only se conserva intacto: el débito original queda como está,
-- y cancelar_reserva_atomic aprende a buscarlo por su origen.
--
-- COLUMNA NUEVA — membresia_movimientos.lista_espera_id (uuid, sin FK por el
-- patrón ledger inmutable establecido en 20260524300000). Permite trazar y
-- garantizar anti-doble-débito/refund por entrada.
--
-- STATUS NUEVO — 'expirada' (distinguir de 'cancelado' por usuario). Patrón
-- paranoia por conkey para reemplazar el CHECK sin asumir nombre.
--
-- CONCURRENCIA — mismo patrón del gate:
--   - SELECT ... FOR UPDATE OF m sobre la membresía del socio antes del débito.
--   - Anti doble-débito por entrada: el índice parcial único
--     `lista_espera_unica_activa` impide 2 entradas 'esperando' simultáneas
--     del mismo (usuario, clase). Aun así, el UPDATE en salir + el check de
--     'devolucion' previa cierran cualquier race entre salir + promover +
--     trigger admin + cron.
--   - Anti doble-refund: chequeo `SELECT count(*) ... AND tipo='devolucion'`
--     por lista_espera_id antes de insertar la devolución.
--
-- INTERACCIÓN CON PROMOCIÓN — al promover, la entrada pasa a 'promovido'.
-- A partir de ahí los flujos de refund se hacen IDEMPOTENTES por status:
--   - salir_lista_espera: solo procesa 'esperando' (ya devolvía 0 filas si no
--     estaba esperando).
--   - trg_limpiar_espera_clase_cancelada: solo procesa 'esperando'.
--   - expirar_listas_espera_vencidas: solo procesa 'esperando'.
-- → una vez promovido, el único flujo de refund posible es la cancelación de
-- la reserva nueva. Esa la maneja cancelar_reserva_atomic con el fallback al
-- origen lista_espera (sección H). `_promover_entrada` no toca créditos; el
-- débito original queda intacto en la entrada de lista_espera y, si la
-- reserva promovida se cancela a tiempo, el fallback lo encuentra por
-- lista_espera_id y devuelve. Ningún flujo doble-devuelve: la devolución
-- lleva las DOS claves (reserva_id + lista_espera_id) y cualquier futuro
-- count por cualquier clave la encuentra.
--
-- COMPAT BACKWARDS — las entradas EXISTENTES en sala-demo (creadas antes de
-- esta migración) no tienen débito asociado. No se backfillea. Consecuencia:
-- si una entrada vieja sale/se cancela/expira, NO se hace refund (el chequeo
-- `v_debit_count = 0` lo cubre). Impacto: solo el tenant demo, no plata.
-- ============================================================================

-- ============================================================================
-- A) SCHEMA — columna lista_espera_id en ledger + expirado_at en lista_espera
-- ============================================================================

ALTER TABLE membresia_movimientos
  ADD COLUMN IF NOT EXISTS lista_espera_id uuid;

-- Sin FK: ledger append-only (patrón establecido en 20260524300000). El borrado
-- de una entrada de lista_espera (ej. cascade desde clases/usuarios/tenants) no
-- debe poder reescribir el ledger.
COMMENT ON COLUMN membresia_movimientos.lista_espera_id IS
  'Vínculo opcional a la entrada de lista_espera que motivó el movimiento (débito al anotarse, devolución al salir/expirar/cancelarse la clase). Sin FK por el patrón ledger inmutable: el borrado de una entrada no debe poder mutar el ledger.';

-- Índice parcial para los chequeos de anti-doble-débito/refund por entrada.
CREATE INDEX IF NOT EXISTS idx_membresia_mov_lista_espera
  ON membresia_movimientos (lista_espera_id)
  WHERE lista_espera_id IS NOT NULL;

-- Marca cuándo expiró la entrada (cron). Útil para auditoría y para distinguir
-- 'expirada' de 'cancelado' (que es por el usuario).
ALTER TABLE lista_espera
  ADD COLUMN IF NOT EXISTS expirado_at timestamptz;

COMMENT ON COLUMN lista_espera.expirado_at IS
  'Timestamp en el que la entrada expiró por slot pasado sin promoción (seteado por expirar_listas_espera_vencidas). NULL en entradas activas/canceladas/promovidas.';

-- UNIQUE parcial sobre reserva_id: solo una entrada de lista_espera puede
-- apuntar a una reserva dada. _promover_entrada es el único writer y crea
-- una reserva fresca por llamada → naturalmente único. El índice asienta el
-- invariante para que el fallback de cancelar_reserva_atomic (sección H) no
-- tenga que considerar el caso "múltiples lista_espera por reserva".
CREATE UNIQUE INDEX IF NOT EXISTS lista_espera_reserva_id_unico
  ON lista_espera (reserva_id)
  WHERE reserva_id IS NOT NULL;

-- ============================================================================
-- B) CHECK lista_espera.status — agregar 'expirada' (patrón paranoia)
-- ============================================================================
-- El CHECK original (20260520150000) tiene nombre auto-generado. Lo localizamos
-- por conkey (columna status) y lo dropeamos antes de recrearlo con el set
-- ampliado. Mismo patrón que 20260524300000.
-- ============================================================================

DO $$
DECLARE
  v_status_attnum smallint;
  v_check_name text;
BEGIN
  SELECT attnum INTO v_status_attnum
  FROM pg_attribute
  WHERE attrelid = 'lista_espera'::regclass
    AND attname = 'status'
    AND NOT attisdropped;

  IF v_status_attnum IS NULL THEN
    RAISE EXCEPTION 'D-011: lista_espera.status no existe';
  END IF;

  FOR v_check_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'lista_espera'::regclass
      AND contype = 'c'
      AND conkey = ARRAY[v_status_attnum]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE lista_espera DROP CONSTRAINT %I', v_check_name);
    RAISE NOTICE 'D-011: dropeado CHECK %', v_check_name;
  END LOOP;

  ALTER TABLE lista_espera
    ADD CONSTRAINT lista_espera_status_check
    CHECK (status IN ('esperando', 'promovido', 'cancelado', 'expirada'));
END $$;

COMMENT ON COLUMN lista_espera.status IS
  'esperando=en cola; promovido=se le creó reserva confirmada; cancelado=usuario salió de la lista o admin canceló la clase; expirada=la clase ya empezó sin que se promueva (devuelve crédito si había debitado).';

-- ============================================================================
-- C) anotar_lista_espera — agregar gate de membresía + débito de crédito
-- ============================================================================
-- Reescritura completa (no edit incremental): inserta el gate (mismo bloque
-- que reservar_clase_atomic) entre los chequeos de usuario y el INSERT, y
-- agrega el débito atómico al final. Estructura de errores y mensajes en
-- español, alineada con la del gate.
--
-- BYPASS — solo rol 'miembro' está sujeto al gate + tier + débito. Otros roles
-- (admin/recep/staff) bypassean (igual que reservar_clase_atomic).
--
-- IDÉNTICO al gate: SELECT ... FOR UPDATE OF m, mismo ORDER BY de prioridad,
-- mismas excepciones SIN_MEMBRESIA/MEMBRESIA_CONGELADA/MEMBRESIA_VENCIDA/
-- SIN_CREDITOS, mismo INSERT del movimiento 'debito' (delta=-1) con
-- motivo='lista_espera <clase>'.
--
-- RESPUESTA — agrega `creditos_restantes` al jsonb existente (los clientes que
-- ya leen `success/lista_espera_id/posicion` no se enteran del campo nuevo).
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

  -- Rol y gate de membresía (paralelo a reservar_clase_atomic)
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
    INSERT INTO lista_espera (tenant_id, clase_id, usuario_id, status)
    VALUES (v_tenant_id, p_clase_id, v_user_id, 'esperando')
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

GRANT EXECUTE ON FUNCTION anotar_lista_espera(uuid) TO authenticated;

COMMENT ON FUNCTION anotar_lista_espera(uuid) IS
  'D-011: el miembro se anota en lista de espera. Gate de membresía (socios): SIN_MEMBRESIA / MEMBRESIA_CONGELADA / MEMBRESIA_VENCIDA / SIN_CREDITOS — mismo patrón que reservar_clase_atomic. Débito de crédito (creditos/hibrido) atómico con el INSERT en lista_espera; FOR UPDATE serializa. Admin/recepcionista/staff bypassean. Devuelve { success, lista_espera_id, posicion, creditos_restantes }.';

-- ============================================================================
-- D) salir_lista_espera — agregar bloqueo CLASE_PASADA + devolución de crédito
-- ============================================================================
-- Cambios:
--   1. Bloquea si la clase ya empezó (CLASE_PASADA) — paralelo a RESERVA_PASADA
--      en cancelar_reserva_atomic. Sin esto el socio podría "salir" después
--      del slot y recibir refund, falseando el saldo.
--   2. Devolución de 1 crédito si la entrada había debitado y no se devolvió.
--      Sin ventana de tiempo: salir antes del slot SIEMPRE devuelve (porque
--      todavía no consumió el lugar — la lista de espera no es una reserva
--      confirmada con compromiso, es solo intención).
--
-- COMPAT — entradas viejas sin débito caen en `v_debit_count = 0` → no refund.
-- ============================================================================

CREATE OR REPLACE FUNCTION salir_lista_espera(p_clase_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_entry lista_espera;
  v_clase clases;
  v_tz text;
  v_now timestamptz := now();
  v_slot_inicio timestamptz;

  v_owner_rol text;
  v_mem_id uuid;
  v_tier_tipo text;
  v_debit_count integer;
  v_refund_count integer;
  v_devolver boolean := false;
  v_nuevo_creditos integer;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  -- Lock de la entrada para evitar carrera salir / promover / trigger / cron.
  SELECT * INTO v_entry FROM lista_espera
  WHERE clase_id = p_clase_id
    AND usuario_id = v_user_id
    AND status = 'esperando'
  FOR UPDATE;

  IF v_entry.id IS NULL THEN
    RAISE EXCEPTION 'NO_EN_LISTA: No estás en la lista de espera de esta clase';
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = p_clase_id;
  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);
  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  IF v_slot_inicio <= v_now THEN
    RAISE EXCEPTION 'CLASE_PASADA: Esta clase ya empezó';
  END IF;

  -- Marcar 'cancelado' (el lock anterior garantiza una sola transición).
  UPDATE lista_espera
  SET status = 'cancelado'
  WHERE id = v_entry.id;

  -- ───────────────────────────────────────────────────────────────────────
  -- Devolución de crédito si corresponde (paralelo a cancelar_reserva_atomic)
  -- ───────────────────────────────────────────────────────────────────────
  SELECT rol INTO v_owner_rol FROM usuarios WHERE id = v_user_id;
  IF v_owner_rol = 'miembro' THEN
    SELECT m.id, t.tipo
    INTO v_mem_id, v_tier_tipo
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
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, lista_espera_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_entry.tenant_id, 'devolucion', 1,
      NULL, v_entry.id,
      'salida de lista de espera (' || COALESCE(v_clase.nombre, '') || ')',
      v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'devuelto', v_devolver,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

GRANT EXECUTE ON FUNCTION salir_lista_espera(uuid) TO authenticated;

COMMENT ON FUNCTION salir_lista_espera(uuid) IS
  'D-011: el miembro abandona la lista de espera. CLASE_PASADA bloquea si ya empezó. Devuelve 1 crédito si la entrada había debitado y no se devolvió (anti doble por lista_espera_id en el ledger). Devuelve { success, devuelto, creditos_restantes }.';

-- ============================================================================
-- E) _promover_entrada — NO se toca
-- ============================================================================
-- El socio promovido YA pagó al anotarse (el débito está en la entrada de
-- lista_espera, no en la reserva). _promover_entrada solo crea la reserva
-- 'Promovido desde lista de espera' y marca la entrada 'promovido' con
-- reserva_id = nueva.
--
-- La reserva resultante NO tiene movimiento 'debito' propio. Eso podría
-- romper el refund al cancelar la reserva promovida (5º agujero del header),
-- pero se cubre en la sección H: cancelar_reserva_atomic aprende a buscar
-- el débito por el origen lista_espera cuando no lo encuentra por reserva_id.
-- El ledger queda intacto (no se re-vincula el débito), el patrón append-only
-- se respeta, y el socio recupera su crédito si cancela en regla.

-- ============================================================================
-- F) expirar_listas_espera_vencidas — cron-callable, refunda entradas vencidas
-- ============================================================================
-- Llamada por cron-no-shows (cada hora). Recorre entradas 'esperando' cuyo
-- slot de clase ya pasó (NO se promovieron — la clase llenó y nadie canceló).
-- Marca 'expirada' y devuelve crédito si había debitado.
--
-- IDEMPOTENTE — guarda por status + FOR UPDATE SKIP LOCKED + chequeo anti
-- doble-refund por lista_espera_id. Una segunda corrida del cron sobre las
-- mismas entradas no encuentra 'esperando' → no hace nada.
--
-- TIMEZONE — la comparación slot_inicio vs now() se hace en UTC (ambos son
-- timestamptz). No necesita la tz de la sucursal: timezone_de_sucursal solo
-- aplica al CONSTRUIR slot_inicio desde fecha+hora locales, y eso ya pasó
-- al crearse la clase. Una entrada vencida es una entrada cuyo
-- (clase.fecha + clase.hora_inicio) AT TIME ZONE (tz sucursal) ≤ now().
--
-- BATCH — sin LIMIT: el volumen real es bajo (entradas esperando con slot
-- vencido en la última hora). Si en el futuro esto escala, agregar LIMIT y
-- correr múltiples batches.
-- ============================================================================

CREATE OR REPLACE FUNCTION expirar_listas_espera_vencidas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry record;
  v_now timestamptz := now();
  v_expiradas integer := 0;
  v_refundadas integer := 0;

  v_mem_id uuid;
  v_tier_tipo text;
  v_debit_count integer;
  v_refund_count integer;
BEGIN
  FOR v_entry IN
    SELECT le.id AS le_id,
           le.tenant_id,
           le.usuario_id,
           le.clase_id,
           c.nombre AS clase_nombre,
           c.fecha,
           c.hora_inicio,
           c.sucursal_id
    FROM lista_espera le
    JOIN clases c ON c.id = le.clase_id
    WHERE le.status = 'esperando'
      AND (c.fecha + c.hora_inicio) AT TIME ZONE
            timezone_de_sucursal(c.sucursal_id, c.tenant_id) <= v_now
    FOR UPDATE OF le SKIP LOCKED
  LOOP
    -- Transición a 'expirada' (idempotente: si otra corrida concurrente la
    -- tocó, el FOR UPDATE SKIP LOCKED ya la habría salteado; igual reaseguro
    -- con un AND status='esperando' en el UPDATE).
    UPDATE lista_espera
    SET status = 'expirada', expirado_at = v_now
    WHERE id = v_entry.le_id
      AND status = 'esperando';
    IF NOT FOUND THEN CONTINUE; END IF;
    v_expiradas := v_expiradas + 1;

    -- Refund si la entrada había debitado y no se devolvió.
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

    IF v_mem_id IS NULL OR v_tier_tipo NOT IN ('creditos', 'hibrido') THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_debit_count
    FROM membresia_movimientos
    WHERE membresia_id = v_mem_id
      AND lista_espera_id = v_entry.le_id
      AND tipo = 'debito';

    SELECT count(*) INTO v_refund_count
    FROM membresia_movimientos
    WHERE membresia_id = v_mem_id
      AND lista_espera_id = v_entry.le_id
      AND tipo = 'devolucion';

    IF v_debit_count = 0 OR v_refund_count > 0 THEN
      CONTINUE;
    END IF;

    UPDATE membresias
    SET creditos_restantes = COALESCE(creditos_restantes, 0) + 1
    WHERE id = v_mem_id;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, lista_espera_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_entry.tenant_id, 'devolucion', 1,
      NULL, v_entry.le_id,
      'expiración de lista de espera (' || COALESCE(v_entry.clase_nombre, '') || ')',
      NULL  -- cron: sin created_by
    );

    v_refundadas := v_refundadas + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'expiradas', v_expiradas,
    'refundadas', v_refundadas,
    'ejecutado_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION expirar_listas_espera_vencidas() FROM PUBLIC;
-- Invocable solo por service_role (cron) — los clientes no la usan.

COMMENT ON FUNCTION expirar_listas_espera_vencidas() IS
  'D-011 cron: marca entradas de lista_espera "esperando" con slot vencido como "expirada" y devuelve crédito si habían debitado. Idempotente vía FOR UPDATE SKIP LOCKED + guarda por status + anti doble-refund por lista_espera_id. Invocable solo por service_role.';

-- ============================================================================
-- G) trg_limpiar_espera_clase_cancelada — amplificar con refund por entrada
-- ============================================================================
-- Cuando el admin cancela una clase, todas las entradas 'esperando' de esa
-- clase pasan a 'cancelado'. Si habían debitado, se les devuelve el crédito.
--
-- LOOP en lugar de UPDATE masivo: necesitamos insertar movimientos por entrada
-- en el ledger. Volumen bajo (entradas en cola de una clase específica).
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_limpiar_espera_clase_cancelada()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry record;
  v_mem_id uuid;
  v_tier_tipo text;
  v_debit_count integer;
  v_refund_count integer;
BEGIN
  FOR v_entry IN
    SELECT le.id AS le_id,
           le.tenant_id,
           le.usuario_id
    FROM lista_espera le
    WHERE le.clase_id = NEW.id
      AND le.status = 'esperando'
    FOR UPDATE OF le
  LOOP
    UPDATE lista_espera
    SET status = 'cancelado'
    WHERE id = v_entry.le_id;

    -- Refund si había debitado y no se devolvió.
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

    IF v_mem_id IS NULL OR v_tier_tipo NOT IN ('creditos', 'hibrido') THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_debit_count
    FROM membresia_movimientos
    WHERE membresia_id = v_mem_id
      AND lista_espera_id = v_entry.le_id
      AND tipo = 'debito';

    SELECT count(*) INTO v_refund_count
    FROM membresia_movimientos
    WHERE membresia_id = v_mem_id
      AND lista_espera_id = v_entry.le_id
      AND tipo = 'devolucion';

    IF v_debit_count = 0 OR v_refund_count > 0 THEN
      CONTINUE;
    END IF;

    UPDATE membresias
    SET creditos_restantes = COALESCE(creditos_restantes, 0) + 1
    WHERE id = v_mem_id;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, lista_espera_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_entry.tenant_id, 'devolucion', 1,
      NULL, v_entry.le_id,
      'clase cancelada por admin (entrada de lista de espera)',
      NULL
    );
  END LOOP;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION trg_limpiar_espera_clase_cancelada() FROM PUBLIC;

COMMENT ON FUNCTION trg_limpiar_espera_clase_cancelada() IS
  'D-011: trigger AFTER UPDATE en clases cuando se cancela. Marca entradas "esperando" como "cancelado" y devuelve crédito por entrada si había debitado y no se devolvió. Anti doble-refund por lista_espera_id.';

-- El trigger en sí no cambia (mismo nombre, mismo WHEN). Solo se reemplaza la
-- función que ejecuta. No es necesario DROP+CREATE del trigger.

-- ============================================================================
-- H) cancelar_reserva_atomic — fallback al origen lista_espera (5º agujero)
-- ============================================================================
-- Cuando se cancela una reserva que vino de promoción de lista de espera, el
-- débito original NO está atado a la reserva (reserva_id NULL en el ledger)
-- sino a la entrada de lista_espera. La versión actual (20260524400000) busca
-- débito solo por reserva_id → no encuentra → no devuelve → el socio pierde
-- crédito que pagó al anotarse.
--
-- FALLBACK — si el primer count por reserva_id da 0, buscar la entrada de
-- lista_espera con status='promovido' y reserva_id = la que estoy cancelando.
-- Si existe, contar débito/devolución por su lista_espera_id. Si hubo débito
-- sin devolver, marcar v_devolver := true.
--
-- INVARIANTE GARANTIZADA — lista_espera.reserva_id es UNIQUE parcial (sección
-- A). Solo puede haber UNA entrada apuntando a una reserva dada. _promover_
-- entrada es el único writer y crea una reserva fresca por llamada (INSERT
-- RETURNING). El LIMIT 1 es redundante con el UNIQUE pero defensivo.
--
-- ANTI DOBLE-REFUND POR DOS CLAVES — la devolución se inserta con AMBAS:
-- reserva_id = R (compatibilidad con el chequeo viejo) Y lista_espera_id =
-- LE_origen (cubre el chequeo nuevo). Cualquier futura llamada — sea
-- cancelar_reserva_atomic, salir_lista_espera, expirar, trg_limpiar — que
-- busque por cualquiera de las dos claves encuentra el refund y no duplica.
-- (En la práctica, los otros flujos solo procesan status='esperando' y la
-- entrada ya está 'promovido' acá; el doble cierre es belt-and-suspenders.)
--
-- CASO NORMAL INTACTO — el fallback corre SOLO si v_debit_count = 0 tras la
-- búsqueda por reserva_id. Toda reserva creada por reservar_clase_atomic
-- tiene su débito por reserva_id → primer count = 1 → fallback no corre →
-- comportamiento idéntico. Los 19 tests SQL existentes + cancelacion siguen
-- válidos. (Test 4 de test_membresias_cancelacion.sql, "Cancelar reserva sin
-- débito previo", también queda igual: la mock reserva no tiene entrada de
-- lista_espera apuntándola → v_le_origen queda NULL → motivo='sin_credito'.)
--
-- CONCURRENCIA — el fallback corre dentro del mismo bloque protegido por
-- FOR UPDATE OF m. Ningún otro flujo puede agregar/borrar débitos para esa
-- membresía mientras tengamos el lock. Anti-race ya validado en Fase 2B.
--
-- Mismo tipo de retorno (jsonb) → CREATE OR REPLACE alcanza. GRANTs se
-- preservan (no hay DROP). Re-grant defensivo al final.
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

COMMENT ON FUNCTION cancelar_reserva_atomic(uuid, text) IS
  'D-011: cancela una reserva confirmada. Misma semántica de ventana + devolución que Fase 2B, AGREGADO: si la reserva vino de promoción de lista de espera (no hay débito por reserva_id), busca el débito por el origen lista_espera (entrada con status=promovido apuntando a esta reserva). Devolución se inserta con reserva_id + lista_espera_id para cerrar anti-doble-refund por ambas claves. Caso normal inalterado: el fallback solo corre cuando v_debit_count=0 por reserva_id.';

-- Re-grant defensivo (CREATE OR REPLACE preserva GRANTs, pero por las dudas).
GRANT EXECUTE ON FUNCTION cancelar_reserva_atomic(uuid, text) TO authenticated;

-- ============================================================================
-- I) VERIFICACIÓN
-- ============================================================================

DO $$
DECLARE
  v_col_existe boolean;
  v_status_check boolean;
  v_unique_idx boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'membresia_movimientos'
      AND column_name = 'lista_espera_id'
  ) INTO v_col_existe;
  IF NOT v_col_existe THEN
    RAISE EXCEPTION 'D-011: membresia_movimientos.lista_espera_id no se creó';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'lista_espera'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%expirada%'
  ) INTO v_status_check;
  IF NOT v_status_check THEN
    RAISE EXCEPTION 'D-011: CHECK lista_espera.status no incluye "expirada"';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'lista_espera'
      AND indexname = 'lista_espera_reserva_id_unico'
  ) INTO v_unique_idx;
  IF NOT v_unique_idx THEN
    RAISE EXCEPTION 'D-011: índice UNIQUE en lista_espera.reserva_id no se creó';
  END IF;

  RAISE NOTICE 'D-011 OK: anotar+debit, salir+refund, expirar+refund, trg admin-cancela+refund, cancelar promovida+refund (5º agujero). Probá con scripts/test_lista_espera_credito.sql.';
END $$;
