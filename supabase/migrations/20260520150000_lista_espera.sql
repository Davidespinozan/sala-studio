-- ============================================================================
-- Sprint LISTA DE ESPERA — waitlist con promoción automática FIFO
-- ============================================================================
-- Cuando una clase llega a cupo_max, el miembro puede anotarse en lista de
-- espera. Al cancelarse una reserva confirmada, el primero en la lista (FIFO)
-- es promovido automáticamente a reserva confirmada.
--
-- DECISIONES DE DISEÑO (ver reporte del sprint):
--
--   1. TABLA NUEVA `lista_espera` (no un status nuevo en `reservas`).
--      `reservas` carga invariantes de booking (folio, slot_inicio/fin NOT NULL,
--      check-in, no-show) y la consumen ~15 archivos de reportes/dashboards que
--      filtran por status. Inyectar un status 'en_espera' corrompería silencio-
--      samente cada conteo. Una tabla dedicada mantiene el waitlist ortogonal.
--
--   2. POSICIÓN FIFO derivada de (created_at, id) — sin columna `posicion` que
--      recalcular en cada promoción/salida. Más robusto.
--
--   3. PROMOCIÓN vía TRIGGER en `reservas` (no en un solo RPC). Hay TRES rutas
--      de cancelación de reservas individuales (RPC miembro `cancelar_reserva_
--      atomic` → 'cancelada'; admin modal → 'cancelada_admin'; admin quick →
--      'cancelada'). Un trigger es el único chokepoint que las cubre todas.
--      La cancelación de una CLASE completa solo toca la tabla `clases`, NO
--      `reservas`, así que el trigger no dispara ahí — correcto: no se promueve
--      a nadie a una clase cancelada.
--
--   4. RACE CONDITIONS: la promoción usa `FOR UPDATE SKIP LOCKED` sobre las
--      entradas de lista_espera. Dos cancelaciones concurrentes bloquean
--      entradas distintas → promueven a 2 personas distintas (correcto: se
--      liberaron 2 lugares). Nunca se promueve dos veces a la misma persona ni
--      se saltea gente. Cancelar+promover ocurre en una sola transacción, así
--      que un observador externo (ej. reservar_clase_atomic concurrente) nunca
--      ve el lugar transitoriamente libre → sin overbooking.
-- ============================================================================

-- ============================================================================
-- A) TABLA lista_espera
-- ============================================================================

CREATE TABLE IF NOT EXISTS lista_espera (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  clase_id uuid NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'esperando'
    CHECK (status IN ('esperando', 'promovido', 'cancelado')),

  created_at timestamptz NOT NULL DEFAULT now(),
  promovido_at timestamptz,

  -- Reserva creada al promover (traza; NULL mientras 'esperando'/'cancelado').
  reserva_id uuid REFERENCES reservas(id) ON DELETE SET NULL
);

-- Un usuario no puede estar 2 veces ESPERANDO en la misma clase.
-- Parcial sobre 'esperando': si sale y vuelve a entrar, la fila vieja
-- ('cancelado') no bloquea la nueva.
CREATE UNIQUE INDEX IF NOT EXISTS lista_espera_unica_activa
  ON lista_espera (clase_id, usuario_id)
  WHERE status = 'esperando';

-- Orden FIFO de promoción / cálculo de posición.
CREATE INDEX IF NOT EXISTS idx_lista_espera_clase_orden
  ON lista_espera (clase_id, created_at, id)
  WHERE status = 'esperando';
CREATE INDEX IF NOT EXISTS idx_lista_espera_usuario
  ON lista_espera (usuario_id);
CREATE INDEX IF NOT EXISTS idx_lista_espera_tenant
  ON lista_espera (tenant_id);

COMMENT ON TABLE lista_espera IS
  'Sprint Lista de Espera: cola FIFO de miembros esperando lugar en una clase llena. Posición = ORDER BY (created_at, id). Promoción automática vía trigger reservas_promover_lista_espera.';
COMMENT ON COLUMN lista_espera.status IS
  'esperando=en cola; promovido=se le creó reserva confirmada; cancelado=salió de la lista o la clase se canceló.';

ALTER TABLE lista_espera ENABLE ROW LEVEL SECURITY;

-- El miembro ve SOLO sus propias entradas; el admin ve todas las del tenant.
-- Las ESCRITURAS van exclusivamente por RPCs SECURITY DEFINER (sin policy de
-- INSERT/UPDATE/DELETE): controla las transiciones de status y la atomicidad.
DROP POLICY IF EXISTS lista_espera_select ON lista_espera;
CREATE POLICY lista_espera_select ON lista_espera
  FOR SELECT
  TO authenticated
  USING (
    usuario_id = get_my_user_id()
    OR (tenant_id = get_my_tenant_id() AND is_admin())
  );

-- ============================================================================
-- B) _promover_entrada — helper interno: crea la reserva + marca + notifica
-- ============================================================================
-- Asume que el caller ya validó cupo libre y que la entrada es promovible.
-- No es invocable por clientes (REVOKE).
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
  v_tenant tenants;
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_folio_count integer;
  v_folio text;
  v_reserva_id uuid;
BEGIN
  SELECT * INTO v_entry FROM lista_espera WHERE id = p_le_id;
  SELECT * INTO v_clase FROM clases WHERE id = v_entry.clase_id;
  SELECT * INTO v_tenant FROM tenants WHERE id = v_clase.tenant_id;

  -- Timezone del tenant para convertir fecha+hora a instante (igual que
  -- reservar_clase_atomic, S4.4).
  v_tz := COALESCE(v_tenant.config->>'timezone', 'America/Mexico_City');
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

REVOKE ALL ON FUNCTION _promover_entrada(uuid) FROM PUBLIC;

COMMENT ON FUNCTION _promover_entrada(uuid) IS
  'Helper interno: crea la reserva confirmada de una entrada de lista_espera, la marca promovido y notifica. El caller valida cupo. No invocable por clientes.';

-- ============================================================================
-- C) promover_siguiente_en_espera — promueve al primer FIFO si hay cupo
-- ============================================================================
-- Llamado por el trigger de cancelación de reservas. Toma al primero en cola
-- con FOR UPDATE SKIP LOCKED (anti race) y salta entradas no promovibles
-- (usuario inactivo / bloqueado / sin tier / ya con reserva).
-- ============================================================================

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
  v_entry lista_espera;
  v_usuario usuarios;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_clase FROM clases WHERE id = p_clase_id;
  -- Clase inexistente o no programada → no se promueve a nadie.
  IF v_clase.id IS NULL OR v_clase.status <> 'programada' THEN
    RETURN NULL;
  END IF;

  -- ¿Quedó cupo libre tras la cancelación?
  SELECT count(*) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada', 'completada');
  IF v_cupos_ocupados >= v_clase.cupo_max THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;

  -- FIFO con lock por fila. SKIP LOCKED: dos cancelaciones concurrentes
  -- bloquean entradas distintas → promueven a personas distintas.
  FOR v_entry IN
    SELECT * FROM lista_espera
    WHERE clase_id = p_clase_id
      AND status = 'esperando'
    ORDER BY created_at ASC, id ASC
    FOR UPDATE SKIP LOCKED
  LOOP
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

    -- Defensivo: ya tiene reserva activa en la clase → cerrar su entrada sin
    -- duplicar y seguir buscando.
    IF EXISTS (
      SELECT 1 FROM reservas
      WHERE clase_id = p_clase_id
        AND usuario_id = v_entry.usuario_id
        AND status IN ('confirmada', 'completada')
    ) THEN
      UPDATE lista_espera
      SET status = 'promovido', promovido_at = v_now
      WHERE id = v_entry.id;
      CONTINUE;
    END IF;

    -- Promover: una cancelación libera un lugar → una promoción.
    PERFORM _promover_entrada(v_entry.id);
    RETURN v_entry.usuario_id;
  END LOOP;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION promover_siguiente_en_espera(uuid) FROM PUBLIC;

COMMENT ON FUNCTION promover_siguiente_en_espera(uuid) IS
  'Promueve al primero en lista de espera (FIFO) si hay cupo libre. Invocado por el trigger reservas_promover_lista_espera. FOR UPDATE SKIP LOCKED evita doble promoción bajo concurrencia.';

-- ============================================================================
-- D) TRIGGER en reservas — promoción automática al cancelar
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_promover_al_cancelar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM promover_siguiente_en_espera(NEW.clase_id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION trg_promover_al_cancelar() FROM PUBLIC;

-- Dispara solo en confirmada → cancelada/cancelada_admin (no en check-in,
-- no en no_show). NEW.clase_id NOT NULL excluye reservas históricas sin clase.
DROP TRIGGER IF EXISTS reservas_promover_lista_espera ON reservas;
CREATE TRIGGER reservas_promover_lista_espera
  AFTER UPDATE ON reservas
  FOR EACH ROW
  WHEN (
    OLD.status = 'confirmada'
    AND NEW.status IN ('cancelada', 'cancelada_admin')
    AND NEW.clase_id IS NOT NULL
  )
  EXECUTE FUNCTION trg_promover_al_cancelar();

-- ============================================================================
-- E) TRIGGER en clases — limpiar lista de espera al cancelar la clase
-- ============================================================================
-- Cancelar una clase no toca `reservas`, así que el trigger de promoción no
-- dispara. Pero las entradas 'esperando' quedan obsoletas → marcarlas
-- 'cancelado' para que no aparezcan en la app del miembro.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_limpiar_espera_clase_cancelada()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE lista_espera
  SET status = 'cancelado'
  WHERE clase_id = NEW.id
    AND status = 'esperando';
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION trg_limpiar_espera_clase_cancelada() FROM PUBLIC;

DROP TRIGGER IF EXISTS clases_limpiar_lista_espera ON clases;
CREATE TRIGGER clases_limpiar_lista_espera
  AFTER UPDATE ON clases
  FOR EACH ROW
  WHEN (OLD.status <> 'cancelada' AND NEW.status = 'cancelada')
  EXECUTE FUNCTION trg_limpiar_espera_clase_cancelada();

-- ============================================================================
-- F) RPC anotar_lista_espera — el miembro se anota en la cola
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
  v_tenant tenants;
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
  SELECT * INTO v_tenant FROM tenants WHERE id = v_tenant_id;

  IF v_clase.id IS NULL OR v_clase.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;
  IF v_clase.status <> 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible';
  END IF;

  -- La clase no debe haber empezado ya.
  v_tz := COALESCE(v_tenant.config->>'timezone', 'America/Mexico_City');
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

GRANT EXECUTE ON FUNCTION anotar_lista_espera(uuid) TO authenticated;

COMMENT ON FUNCTION anotar_lista_espera(uuid) IS
  'El miembro se anota en la lista de espera de una clase llena. Devuelve { success, lista_espera_id, posicion }.';

-- ============================================================================
-- G) RPC salir_lista_espera — el miembro abandona la cola
-- ============================================================================

CREATE OR REPLACE FUNCTION salir_lista_espera(p_clase_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_count integer;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  UPDATE lista_espera
  SET status = 'cancelado'
  WHERE clase_id = p_clase_id
    AND usuario_id = v_user_id
    AND status = 'esperando';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'NO_EN_LISTA: No estás en la lista de espera de esta clase';
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION salir_lista_espera(uuid) TO authenticated;

COMMENT ON FUNCTION salir_lista_espera(uuid) IS
  'El miembro abandona la lista de espera de una clase (status → cancelado).';

-- ============================================================================
-- H) RPC mi_posicion_lista_espera — estado del miembro en una clase
-- ============================================================================

CREATE OR REPLACE FUNCTION mi_posicion_lista_espera(p_clase_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_entry lista_espera;
  v_posicion integer;
  v_total integer;
  v_promovido_reserva uuid;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT count(*) INTO v_total
  FROM lista_espera
  WHERE clase_id = p_clase_id AND status = 'esperando';

  SELECT * INTO v_entry
  FROM lista_espera
  WHERE clase_id = p_clase_id AND usuario_id = v_user_id AND status = 'esperando'
  LIMIT 1;

  IF v_entry.id IS NOT NULL THEN
    SELECT count(*) INTO v_posicion
    FROM lista_espera
    WHERE clase_id = p_clase_id AND status = 'esperando'
      AND (created_at, id) <= (v_entry.created_at, v_entry.id);

    RETURN jsonb_build_object(
      'en_lista', true,
      'posicion', v_posicion,
      'lista_espera_id', v_entry.id,
      'total', v_total,
      'promovido', false,
      'reserva_id', null
    );
  END IF;

  -- No está esperando: ¿fue promovido?
  SELECT reserva_id INTO v_promovido_reserva
  FROM lista_espera
  WHERE clase_id = p_clase_id AND usuario_id = v_user_id AND status = 'promovido'
  ORDER BY promovido_at DESC NULLS LAST
  LIMIT 1;

  RETURN jsonb_build_object(
    'en_lista', false,
    'posicion', null,
    'lista_espera_id', null,
    'total', v_total,
    'promovido', v_promovido_reserva IS NOT NULL,
    'reserva_id', v_promovido_reserva
  );
END;
$$;

GRANT EXECUTE ON FUNCTION mi_posicion_lista_espera(uuid) TO authenticated;

COMMENT ON FUNCTION mi_posicion_lista_espera(uuid) IS
  'Estado del miembro respecto a la lista de espera de una clase: { en_lista, posicion, total, promovido, reserva_id }.';

-- ============================================================================
-- I) RPC mis_listas_espera — todas las clases donde el miembro espera
-- ============================================================================

CREATE OR REPLACE FUNCTION mis_listas_espera()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_result jsonb;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'lista_espera_id', le.id,
        'clase_id', le.clase_id,
        'created_at', le.created_at,
        'nombre', c.nombre,
        'disciplina', c.disciplina,
        'fecha', c.fecha,
        'hora_inicio', c.hora_inicio,
        'duracion_minutos', c.duracion_minutos,
        'cupo_max', c.cupo_max,
        'posicion', (
          SELECT count(*) FROM lista_espera le2
          WHERE le2.clase_id = le.clase_id
            AND le2.status = 'esperando'
            AND (le2.created_at, le2.id) <= (le.created_at, le.id)
        )
      )
      ORDER BY c.fecha, c.hora_inicio
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM lista_espera le
  JOIN clases c ON c.id = le.clase_id
  WHERE le.usuario_id = v_user_id
    AND le.status = 'esperando'
    AND c.status = 'programada';

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION mis_listas_espera() TO authenticated;

COMMENT ON FUNCTION mis_listas_espera() IS
  'Lista de clases donde el miembro actual está esperando, con posición FIFO y datos de la clase. Para el home / mis reservas.';

-- ============================================================================
-- J) RPC promover_manual_lista_espera — el admin saltea el FIFO
-- ============================================================================

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

  SELECT count(*) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = v_clase.id AND status IN ('confirmada', 'completada');
  IF v_cupos_ocupados >= v_clase.cupo_max THEN
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

GRANT EXECUTE ON FUNCTION promover_manual_lista_espera(uuid) TO authenticated;

COMMENT ON FUNCTION promover_manual_lista_espera(uuid) IS
  'El admin promueve manualmente a una persona de la lista de espera (saltea el FIFO). Requiere cupo libre.';

-- ============================================================================
-- Fin migración Lista de Espera
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migración lista_espera OK: tabla + 6 funciones + 2 triggers.';
END $$;
