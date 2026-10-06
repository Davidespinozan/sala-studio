-- ════════════════════════════════════════════════════════════════════════════
-- CANCELAR RESERVA · INTEGRIDAD (núcleo canónico + wrappers delgados)
-- ────────────────────────────────────────────────────────────────────────────
-- Problemas que cierra:
--   1) TOCTOU en cancelar_reserva_atomic: leía el status SIN lock y después
--      hacía un UPDATE incondicional → dos cancelaciones simultáneas "ganaban"
--      las dos (la segunda pisaba cancelada_at/motivo/por del ganador).
--   2) Devolución perdida: una cancelación que corría contra un cambio de plan
--      (recepcion_cambiar_plan) buscaba "la membresía activa de créditos del
--      socio" con un JOIN a tiers + FOR UPDATE; tras esperar el lock,
--      PostgreSQL re-evalúa (EvalPlanQual) la fila de membresías pero NO el
--      JOIN a tiers → la devolución se perdía en silencio.
--   3) cancelar_reserva_admin era una implementación aparte, con su propio
--      TOCTOU (peor orden: UPDATE incondicional antes de decidir nada) y NUNCA
--      devolvía el crédito de una reserva promovida desde lista de espera
--      (D-011: el débito está atado a lista_espera_id, no a reserva_id).
--
-- Diseño (aprobado por el owner, decisiones R1–R5):
--   · _cancelar_reserva_core(...) — primitiva interna ÚNICA. Es dueña de:
--       a) la transición con guarda (punto de linealización):
--            UPDATE reservas ... WHERE id = X AND status = 'confirmada'
--              AND (p_permitir_pasada OR slot_inicio > now()) RETURNING *
--          0 filas → error (RESERVA_YA_CANCELADA / RESERVA_NO_CANCELABLE /
--          RESERVA_PASADA) y CERO efectos económicos.
--       b) la autoridad de devolución: evidencia económica inmutable
--          (reservas.membresia_id → lista_espera.membresia_id → la membresía del
--          débito en el ledger). Monto = débito neto en el ledger para esta
--          reserva (o su origen en lista de espera) menos devoluciones ya hechas
--          — nunca "la membresía activa de hoy" ni 1+invitados recalculado.
--       c) orden de locks R → X → M, EXACTO:
--            R = la fila de la reserva (el UPDATE con guarda, primer lock).
--            X = advisory 'clase_lugares:<clase>' — lo toma SOLO el trigger
--                reservas_promover_lista_espera al disparar con el UPDATE
--                (promover_siguiente_en_espera). El núcleo no lo pide explícito.
--            M = la membresía, bloqueada POR SU ID (sin JOIN) y SOLO si hay un
--                débito neto que devolver dentro de la ventana (o admin). Este
--                gating es load-bearing: _liberar_reservas_membresia solo toca
--                reservas SIN débito, así que sus condiciones de lock de M nunca
--                se solapan con las de este núcleo.
--       d) R5: después del lock de M se relee el tier ACTUAL. Si hoy es de tipo
--          'tiempo' NO se acredita nada (resultado 'sin_credito'), aunque el
--          débito haya ocurrido bajo un tier de créditos/híbrido.
--       e) el asiento del ledger (vía _aplicar_credito, canónico) y la forma
--          canónica del resultado.
--   · Wrappers delgados por rol (sin lógica económica):
--       - cancelar_reserva_atomic   (socio dueño o staff): ventana aplica,
--         no permite clase empezada, destino 'cancelada'.
--       - recepcion_cancelar_reserva: SIN CAMBIOS — ya era un wrapper que delega
--         en cancelar_reserva_atomic en la misma transacción; su bitácora corre
--         solo si la delegación no lanzó (un perdedor de la carrera aborta todo).
--       - cancelar_reserva_admin (recepción/admin): ventana NO aplica (siempre
--         devuelve), permite clase pasada, destino 'cancelada_admin';
--         notificación (si p_notificar) + bitácora SOLO tras éxito real.
--   · cancelar_clase: parche aditivo de UNA sentencia — bloquea por adelantado
--     todas las reservas 'confirmada' de la clase antes de su loop (los cursores
--     PL/pgSQL bloquean filas de a poco → deadlock contra R → X → M). Nada más
--     de cancelar_clase cambia.
--
-- Fuera de alcance (registrado, no tocado):
--   · R1: riesgo residual aceptado de deadlock cancelación vs cron de expiración
--     multi-membresía (_liberar_reservas_membresia / expirar_membresias_vencidas
--     / webhook de Stripe sin cambios).
--   · R4: gestionar_membresia_socio sin cambios (asimetría de créditos
--     reservados al cambiar de tipo de plan = issue aparte, preexistente).
--
-- GRANTs: CREATE OR REPLACE conserva los ACL existentes de los wrappers y de
-- cancelar_clase. El núcleo nace con REVOKE de PUBLIC/anon/authenticated.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1) NÚCLEO CANÓNICO ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._cancelar_reserva_core(
  p_reserva_id      uuid,
  p_actor           uuid,
  p_destino_status  text,     -- 'cancelada' (socio/recepción) | 'cancelada_admin' (gimnasio)
  p_motivo          text,
  p_aplica_ventana  boolean,  -- true: devuelve solo si se cancela a tiempo; false: siempre
  p_permitir_pasada boolean   -- true: admin puede cancelar una clase que ya empezó
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now          timestamptz := now();
  v_res          reservas;     -- la fila tal como la transicionó ESTA transacción
  v_cur_status   text;
  v_ventana_h    integer;
  v_es_a_tiempo  boolean;
  v_owner_rol    text;
  v_le_origen    uuid;
  v_le_mem       uuid;
  v_mem_id       uuid;
  v_neto         integer := 0;
  v_mem_status   text;
  v_mem_tier     uuid;
  v_tier_tipo    text;
  v_clase_nombre text;
  v_devolver     boolean := false;
  v_tarde        boolean := false;
  v_motivo_dev   text;
  v_motivo_led   text;
  v_monto        integer := 0;
  v_nuevo        integer;
BEGIN
  IF p_destino_status IS NULL OR p_destino_status NOT IN ('cancelada', 'cancelada_admin') THEN
    RAISE EXCEPTION 'DESTINO_INVALIDO: estado destino % no permitido', p_destino_status;
  END IF;

  -- (1) PUNTO DE LINEALIZACIÓN — transición con guarda (lock R).
  --     El trigger reservas_promover_lista_espera dispara aquí y toma X.
  UPDATE reservas
  SET status = p_destino_status, cancelada_at = v_now, cancelada_motivo = p_motivo, cancelada_por = p_actor
  WHERE id = p_reserva_id AND status = 'confirmada'
    AND (p_permitir_pasada OR slot_inicio > v_now)
  RETURNING * INTO v_res;

  IF NOT FOUND THEN
    -- Ninguna fila transicionada: solo elegir el código de error correcto.
    -- Sin devolución, sin ledger, sin notificación, sin bitácora.
    SELECT status INTO v_cur_status FROM reservas WHERE id = p_reserva_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
    ELSIF v_cur_status IN ('cancelada', 'cancelada_admin') THEN
      RAISE EXCEPTION 'RESERVA_YA_CANCELADA: la reserva ya estaba cancelada (status: %)', v_cur_status;
    ELSIF v_cur_status <> 'confirmada' THEN
      RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: La reserva no está confirmada (status: %)', v_cur_status;
    ELSE
      RAISE EXCEPTION 'RESERVA_PASADA: No puedes cancelar una reserva cuya clase ya empezó';
    END IF;
  END IF;

  -- (2) Ventana de cancelación (solo decide la devolución, no bloquea).
  SELECT COALESCE((config->'reserva'->>'cancelacion_min_horas')::integer, 4)
    INTO v_ventana_h FROM tenants WHERE id = v_res.tenant_id;
  v_ventana_h := COALESCE(v_ventana_h, 4);
  v_es_a_tiempo := v_now < (v_res.slot_inicio - make_interval(hours => v_ventana_h));

  SELECT rol INTO v_owner_rol FROM usuarios WHERE id = v_res.usuario_id;

  -- (3) Procedencia económica inmutable (sin lock): origen D-011 + membresía
  --     que quedó registrada al reservar / al anotarse / en el débito.
  SELECT le.id, le.membresia_id INTO v_le_origen, v_le_mem
  FROM lista_espera le
  WHERE le.reserva_id = p_reserva_id AND le.status = 'promovido'
  LIMIT 1;

  v_mem_id := COALESCE(v_res.membresia_id, v_le_mem);
  IF v_mem_id IS NULL THEN
    -- Reservas legacy sin procedencia: la membresía del propio débito.
    SELECT mm.membresia_id INTO v_mem_id
    FROM membresia_movimientos mm
    WHERE mm.tipo = 'debito'
      AND (mm.reserva_id = p_reserva_id
           OR (v_le_origen IS NOT NULL AND mm.lista_espera_id = v_le_origen))
    ORDER BY mm.created_at, mm.id
    LIMIT 1;
  END IF;

  IF v_mem_id IS NOT NULL THEN
    SELECT COALESCE(SUM(-delta_creditos) FILTER (WHERE tipo = 'debito'), 0)
         - COALESCE(SUM(delta_creditos)  FILTER (WHERE tipo = 'devolucion'), 0)
      INTO v_neto
    FROM membresia_movimientos
    WHERE membresia_id = v_mem_id
      AND (reserva_id = p_reserva_id
           OR (v_le_origen IS NOT NULL AND lista_espera_id = v_le_origen));
  END IF;

  -- (4) Lock M SOLO si hay algo que devolver (débito neto > 0, y a tiempo o
  --     admin). Por su id, sin JOIN (sin anomalía EvalPlanQual).
  IF v_neto > 0 AND (NOT p_aplica_ventana OR v_es_a_tiempo) THEN
    SELECT m.status, m.tier_id INTO v_mem_status, v_mem_tier
    FROM membresias m
    WHERE m.id = v_mem_id
    FOR UPDATE;

    -- Relecturas frescas tras el lock (sentencias nuevas = snapshot nuevo).
    SELECT t.tipo INTO v_tier_tipo FROM tiers t WHERE t.id = v_mem_tier;

    SELECT COALESCE(SUM(-delta_creditos) FILTER (WHERE tipo = 'debito'), 0)
         - COALESCE(SUM(delta_creditos)  FILTER (WHERE tipo = 'devolucion'), 0)
      INTO v_neto
    FROM membresia_movimientos
    WHERE membresia_id = v_mem_id
      AND (reserva_id = p_reserva_id
           OR (v_le_origen IS NOT NULL AND lista_espera_id = v_le_origen));

    -- R5: nunca acreditar en una membresía cuyo tier ACTUAL es de tiempo.
    IF v_neto > 0
       AND v_mem_status IN ('trialing', 'activa', 'past_due', 'congelada')
       AND v_tier_tipo IN ('creditos', 'hibrido') THEN
      v_devolver := true;
      v_monto := v_neto;
    END IF;
  ELSIF v_neto > 0 THEN
    -- Fuera de ventana: no se devuelve ni se bloquea M. Solo para la etiqueta
    -- (mismo criterio que antes: 'tarde' únicamente en tier de créditos/híbrido).
    SELECT m.status, t.tipo INTO v_mem_status, v_tier_tipo
    FROM membresias m JOIN tiers t ON t.id = m.tier_id
    WHERE m.id = v_mem_id;
    v_tarde := v_mem_status IN ('trialing', 'activa', 'past_due', 'congelada')
               AND v_tier_tipo IN ('creditos', 'hibrido');
  END IF;

  -- (5) Ledger + saldo (canónico, mismo tx).
  IF v_devolver THEN
    IF p_destino_status = 'cancelada_admin' THEN
      SELECT nombre INTO v_clase_nombre FROM clases WHERE id = v_res.clase_id;
      v_motivo_led := 'cancelación del gimnasio (' || COALESCE(v_clase_nombre, '') || ')';
    ELSE
      v_motivo_led :=
        CASE WHEN v_le_origen IS NOT NULL
             THEN 'cancelación a tiempo de reserva promovida '
             ELSE 'cancelación a tiempo de reserva ' END
        || COALESCE(v_res.folio, '(sin folio)')
        || CASE WHEN COALESCE(v_res.invitados_count, 0) > 0
                THEN ' (+' || v_res.invitados_count || ' invitado(s))' ELSE '' END;
    END IF;

    v_nuevo := _aplicar_credito(
      v_mem_id, v_monto, 'devolucion', v_motivo_led,
      p_reserva_id, v_le_origen, p_actor
    );
  END IF;

  v_motivo_dev := CASE
    WHEN v_devolver THEN 'a_tiempo'
    WHEN v_tarde THEN 'tarde'
    WHEN v_owner_rol IS DISTINCT FROM 'miembro' THEN 'no_aplica'
    ELSE 'sin_credito'
  END;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', p_reserva_id,
    'status', v_res.status,
    'devuelto', v_devolver,
    'devolucion_motivo', v_motivo_dev,
    'ventana_horas', v_ventana_h,
    'creditos_devueltos', CASE WHEN v_devolver THEN v_monto ELSE 0 END,
    'creditos_restantes', v_nuevo
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._cancelar_reserva_core(uuid, uuid, text, text, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cancelar_reserva_core(uuid, uuid, text, text, boolean, boolean) FROM anon;
REVOKE ALL ON FUNCTION public._cancelar_reserva_core(uuid, uuid, text, text, boolean, boolean) FROM authenticated;

-- ── 2) WRAPPER SOCIO / STAFF ────────────────────────────────────────────────
-- Misma firma y contrato. Autorización intacta (dueño o staff del tenant +
-- guarda de sede #9). La transición y la economía viven en el núcleo.
CREATE OR REPLACE FUNCTION public.cancelar_reserva_atomic(p_reserva_id uuid, p_motivo text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_reserva reservas;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  -- Lectura sin lock: solo campos inmutables (usuario_id, tenant_id, clase_id).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.usuario_id <> v_user_id AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: No puedes cancelar esta reserva';
  END IF;

  IF v_reserva.usuario_id <> v_user_id AND v_reserva.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: Esta reserva es de otro gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));

  RETURN _cancelar_reserva_core(
    p_reserva_id, v_user_id, 'cancelada', p_motivo,
    true,   -- p_aplica_ventana
    false   -- p_permitir_pasada
  );
END;
$function$;

-- ── 3) WRAPPER ADMIN / RECEPCIÓN (cancelación del gimnasio) ─────────────────
-- Misma firma y forma de respuesta ({success, reserva_id, devuelto}).
-- Siempre devuelve (sin ventana), permite clase pasada. Notificación y bitácora
-- solo si el núcleo transicionó la fila en ESTA transacción.
CREATE OR REPLACE FUNCTION public.cancelar_reserva_admin(p_reserva_id uuid, p_motivo text DEFAULT NULL::text, p_notificar boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_actor uuid := get_my_user_id();
  v_motivo text := COALESCE(NULLIF(trim(p_motivo), ''), 'Cancelada por el gimnasio');
  v_res reservas;
  v_out jsonb;
  v_clase_nombre text;
  v_socio_nombre text;
  v_devolvio boolean;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden cancelar una reserva';
  END IF;

  -- Lectura sin lock: solo campos inmutables (tenant_id, clase_id, usuario_id, slot_inicio).
  SELECT * INTO v_res FROM reservas WHERE id = p_reserva_id;
  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;
  IF v_res.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa reserva no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_res.clase_id));

  v_out := _cancelar_reserva_core(
    p_reserva_id, v_actor, 'cancelada_admin', v_motivo,
    false,  -- p_aplica_ventana (cancelación del gimnasio = siempre devuelve)
    true    -- p_permitir_pasada
  );
  v_devolvio := COALESCE((v_out->>'devuelto')::boolean, false);

  SELECT nombre INTO v_clase_nombre FROM clases WHERE id = v_res.clase_id;
  SELECT nombre INTO v_socio_nombre FROM usuarios WHERE id = v_res.usuario_id;

  IF p_notificar THEN
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_tenant, v_res.usuario_id, 'reserva_cancelada', 'Reserva cancelada',
      'El gimnasio canceló tu reserva'
        || CASE WHEN v_clase_nombre IS NOT NULL THEN ' de ' || v_clase_nombre ELSE '' END || '.'
        || CASE WHEN v_devolvio THEN ' Se te devolvió el crédito.' ELSE '' END,
      jsonb_build_object('reserva_id', p_reserva_id, 'clase_id', v_res.clase_id)
    );
  END IF;

  PERFORM _audrec_log(
    'reserva.cancelar', 'reserva', p_reserva_id, v_res.usuario_id, v_socio_nombre,
    format('Canceló la reserva del %s%s. Motivo: %s',
           to_char(v_res.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN v_devolvio THEN ' (crédito devuelto)' ELSE '' END, v_motivo),
    jsonb_build_object('reserva_id', p_reserva_id, 'devuelto', v_devolvio, 'motivo', v_motivo)
  );

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id, 'devuelto', v_devolvio);
END $function$;

-- ── 4) cancelar_clase — parche ADITIVO de una sentencia ─────────────────────
-- Único cambio: el PERFORM ... FOR UPDATE antes del loop de reservas
-- confirmadas. Todo lo demás es idéntico a 20261005260000.
CREATE OR REPLACE FUNCTION public.cancelar_clase(p_clase_id uuid DEFAULT NULL::uuid, p_horario_id uuid DEFAULT NULL::uuid, p_fecha date DEFAULT NULL::date, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_clase.sucursal_id);
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

  -- Integridad de cancelación: bloquear TODAS las reservas confirmadas de la
  -- clase de una vez, antes del primer UPDATE (que dispara el trigger que toma
  -- el advisory de la clase). El cursor de abajo bloquea de a poco; sin esto,
  -- cancelar_clase podía tener X y esperar una R que una cancelación individual
  -- (R → X → M) ya tenía → deadlock.
  PERFORM 1 FROM reservas WHERE clase_id = v_clase_id AND status = 'confirmada' ORDER BY id FOR UPDATE;

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
END $function$;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST (devuelve TABLA). Diagnóstico puro: crea un gym desechable, corre
-- los casos secuenciales y REVIERTE TODO con una excepción centinela antes de
-- devolver las filas (los resultados viven en variables, que no se revierten).
-- No deja residuo; la última fila lo verifica. Se borra a sí mismo al final.
-- Corre como el dueño de la migración (salta RLS). La concurrencia (carreras,
-- deadlocks, orden de locks) se prueba aparte en sandbox con varias conexiones.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_cancelar_reserva_integridad()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_slug text := 'zz-cri-' || substr(md5(random()::text), 1, 6);
  v_p text[] := ARRAY[]::text[];
  v_r text[] := ARRAY[]::text[];
  v_t uuid; v_sa uuid; v_tz text;
  t_credA uuid; t_credB uuid; t_hib uuid; t_hib2 uuid; t_tiempo uuid;
  v_rec uuid; v_rec_map uuid;
  a_m1 uuid := gen_random_uuid(); a_m2 uuid := gen_random_uuid(); a_m3 uuid := gen_random_uuid();
  a_m4 uuid := gen_random_uuid(); a_m5 uuid := gen_random_uuid(); a_m6 uuid := gen_random_uuid();
  a_adm uuid := gen_random_uuid(); a_rec uuid := gen_random_uuid();
  u_m1 uuid; u_m2 uuid; u_m3 uuid; u_m4 uuid; u_m5 uuid; u_m6 uuid;
  v_mem1 uuid; v_mem2 uuid; v_mem3 uuid; v_mem4 uuid; v_mem5 uuid; v_mem6 uuid;
  v_c1 uuid; v_c2 uuid; v_c3 uuid; v_c4 uuid; v_c5 uuid; v_c6 uuid; v_c7 uuid; v_cmap uuid; v_ccl uuid; v_clate uuid;
  v_ts timestamptz;
  v_rid uuid; v_rid2 uuid; v_le uuid;
  v_res jsonb; v_err text; v_n int; v_n2 int; v_cred int; v_cred0 int; v_cred1 int;
  v_st text; v_por uuid; v_at timestamptz; v_ok boolean; i int;
BEGIN
  BEGIN
    INSERT INTO tenants (slug, nombre, vertical, status, config)
      VALUES (v_slug, 'CRI Diag', 'gym_libre', 'activo', '{"reserva":{"cancelacion_min_horas":4}}'::jsonb)
      RETURNING id INTO v_t;
    INSERT INTO sucursales (tenant_id, nombre, orden) VALUES (v_t, 'Sede A', 90) RETURNING id INTO v_sa;
    v_tz := timezone_de_sucursal(v_sa, v_t);
    INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas, periodo, activo, invitados_por_periodo)
      VALUES (v_t, 'cri-credA', 'Cred A', 100000, 'creditos', 20, 'mensual', true, 6) RETURNING id INTO t_credA;
    INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas, periodo, activo, invitados_por_periodo)
      VALUES (v_t, 'cri-credB', 'Cred B', 100000, 'creditos', 10, 'mensual', true, 6) RETURNING id INTO t_credB;
    INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas, periodo, activo, invitados_por_periodo)
      VALUES (v_t, 'cri-hib', 'Hibrido', 100000, 'hibrido', 20, 'mensual', true, 6) RETURNING id INTO t_hib;
    INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas, periodo, activo, invitados_por_periodo)
      VALUES (v_t, 'cri-hib2', 'Hibrido 2', 100000, 'hibrido', 10, 'mensual', true, 6) RETURNING id INTO t_hib2;
    INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas, periodo, activo, invitados_por_periodo)
      VALUES (v_t, 'cri-tiempo', 'Tiempo', 100000, 'tiempo', NULL, 'mensual', true, 6) RETURNING id INTO t_tiempo;
    INSERT INTO recursos (tenant_id, slug, nombre, sucursal_id, tipo, cupo_max_default, tiers_permitidos)
      VALUES (v_t, 'cri-sala', 'Sala', v_sa, 'sala_grupal', 10, ARRAY['cri-credA','cri-credB','cri-hib','cri-hib2','cri-tiempo'])
      RETURNING id INTO v_rec;
    INSERT INTO recursos (tenant_id, slug, nombre, sucursal_id, tipo, cupo_max_default, tiers_permitidos, layout)
      VALUES (v_t, 'cri-mapa', 'Mapa', v_sa, 'sala_grupal', 4, ARRAY['cri-credA','cri-credB','cri-hib','cri-hib2','cri-tiempo'],
              jsonb_build_object('lugares', (SELECT jsonb_agg(jsonb_build_object('id', 'L'||g)) FROM generate_series(1,4) g)))
      RETURNING id INTO v_rec_map;

    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
    SELECT x.a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-'||x.n||'@sala.dev',
           jsonb_build_object('tenant_slug', v_slug, 'nombre', x.n), '', now(), now(), now()
    FROM (VALUES (a_m1,'M1'),(a_m2,'M2'),(a_m3,'M3'),(a_m4,'M4'),(a_m5,'M5'),(a_m6,'M6'),(a_adm,'Adm'),(a_rec,'Rec')) AS x(a, n);
    UPDATE usuarios SET rol = 'miembro', status = 'activo', sucursal_id = v_sa
      WHERE auth_id IN (a_m1, a_m2, a_m3, a_m4, a_m5, a_m6);
    UPDATE usuarios SET rol = 'admin', status = 'activo', sucursal_id = v_sa WHERE auth_id = a_adm;
    UPDATE usuarios SET rol = 'recepcionista', status = 'activo', sucursal_id = v_sa WHERE auth_id = a_rec;
    SELECT id INTO u_m1 FROM usuarios WHERE auth_id = a_m1;
    SELECT id INTO u_m2 FROM usuarios WHERE auth_id = a_m2;
    SELECT id INTO u_m3 FROM usuarios WHERE auth_id = a_m3;
    SELECT id INTO u_m4 FROM usuarios WHERE auth_id = a_m4;
    SELECT id INTO u_m5 FROM usuarios WHERE auth_id = a_m5;
    SELECT id INTO u_m6 FROM usuarios WHERE auth_id = a_m6;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_t, u_m1, t_credA, 'activa', v_sa, 20, now() - interval '1 day', now() + interval '60 days') RETURNING id INTO v_mem1;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_t, u_m2, t_credA, 'activa', v_sa, 20, now() - interval '1 day', now() + interval '60 days') RETURNING id INTO v_mem2;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_t, u_m3, t_credA, 'activa', v_sa, 20, now() - interval '1 day', now() + interval '60 days') RETURNING id INTO v_mem3;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_t, u_m4, t_hib, 'activa', v_sa, 20, now() - interval '1 day', now() + interval '60 days') RETURNING id INTO v_mem4;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_t, u_m5, t_credA, 'activa', v_sa, 20, now() - interval '1 day', now() + interval '60 days') RETURNING id INTO v_mem5;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_t, u_m6, t_credA, 'activa', v_sa, 20, now() - interval '1 day', now() + interval '60 days') RETURNING id INTO v_mem6;

    -- Clases futuras (fuera de ventana de 4h)
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE + 10, '08:00', 60, 'CRI C1', 10, 'programada') RETURNING id INTO v_c1;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE + 10, '10:00', 60, 'CRI C2', 10, 'programada') RETURNING id INTO v_c2;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE + 10, '12:00', 60, 'CRI C3 cupo1', 1, 'programada') RETURNING id INTO v_c3;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE + 10, '14:00', 60, 'CRI C4 cupo1', 1, 'programada') RETURNING id INTO v_c4;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE + 10, '16:00', 60, 'CRI C5', 10, 'programada') RETURNING id INTO v_c5;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE + 10, '18:00', 60, 'CRI C6', 10, 'programada') RETURNING id INTO v_c6;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE + 11, '08:00', 60, 'CRI C7', 10, 'programada') RETURNING id INTO v_c7;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec_map, v_sa, CURRENT_DATE + 11, '10:00', 60, 'CRI MAPA', 4, 'programada') RETURNING id INTO v_cmap;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE + 11, '12:00', 60, 'CRI CL', 10, 'programada') RETURNING id INTO v_ccl;
    -- Clase dentro de la ventana (empieza en ~2h)
    v_ts := date_trunc('minute', now()) + interval '2 hours';
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, (v_ts AT TIME ZONE v_tz)::date, (v_ts AT TIME ZONE v_tz)::time, 60, 'CRI LATE', 10, 'programada')
      RETURNING id INTO v_clate;

    -- ── T1: socio cancela a tiempo (crédito) → devuelve 1 ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m1::text)::text, true);
    v_rid := (reservar_clase_atomic(v_c1, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem1;
    v_res := cancelar_reserva_atomic(v_rid, 'diag');
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem1;
    SELECT status, cancelada_por, cancelada_at INTO v_st, v_por, v_at FROM reservas WHERE id = v_rid;
    SELECT count(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_rid AND tipo = 'devolucion' AND delta_creditos = 1;
    v_p := v_p || 'T1. socio cancela a tiempo (créditos): 19→20, 1 devolución, status cancelada, a_tiempo'::text;
    v_r := v_r || CASE WHEN v_cred0 = 19 AND v_cred = 20 AND v_n = 1 AND v_st = 'cancelada' AND v_por = u_m1
                         AND v_res->>'devolucion_motivo' = 'a_tiempo' AND (v_res->>'creditos_devueltos')::int = 1
                         AND (v_res->>'creditos_restantes')::int = 20
      THEN '✅ ok' ELSE '❌ cred '||v_cred0||'→'||v_cred||' dev='||v_n||' st='||v_st||' res='||v_res::text END;

    -- ── T2: segunda cancelación (socio y admin) → RESERVA_YA_CANCELADA, sin efectos ──
    v_err := NULL;
    BEGIN PERFORM cancelar_reserva_atomic(v_rid, 'otra vez'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_adm::text)::text, true);
    v_ok := false;
    BEGIN PERFORM cancelar_reserva_admin(v_rid, 'admin tarde', true); EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'RESERVA_YA_CANCELADA%'; END;
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem1;
    SELECT count(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_rid AND tipo = 'devolucion';
    SELECT count(*) INTO v_n2 FROM notificaciones WHERE metadata->>'reserva_id' = v_rid::text AND tipo = 'reserva_cancelada';
    v_p := v_p || 'T2. re-cancelar (socio y admin) → RESERVA_YA_CANCELADA; saldo, ledger, metadata, notif intactos'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'RESERVA_YA_CANCELADA%' AND v_ok AND v_cred = 20 AND v_n = 1 AND v_n2 = 0
                         AND (SELECT cancelada_por = u_m1 AND cancelada_motivo = 'diag' AND status = 'cancelada' FROM reservas WHERE id = v_rid)
      THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' admin_ok='||v_ok||' cred='||v_cred||' dev='||v_n||' notif='||v_n2 END;

    -- ── T3: cancelación tarde (dentro de 4h) → 'tarde', sin devolución ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m1::text)::text, true);
    v_err := NULL;
    BEGIN
      v_rid := (reservar_clase_atomic(v_clate, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
      SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem1;
      v_res := cancelar_reserva_atomic(v_rid, 'tarde');
    EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem1;
    SELECT count(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_rid AND tipo = 'devolucion';
    v_p := v_p || 'T3. socio cancela tarde (<4h) → devolucion_motivo=tarde, sin crédito'::text;
    v_r := v_r || CASE WHEN v_err IS NULL AND v_res->>'devolucion_motivo' = 'tarde' AND NOT (v_res->>'devuelto')::boolean
                         AND v_cred = v_cred0 AND v_n = 0
      THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'-')||' res='||coalesce(v_res::text,'-')||' cred '||v_cred0||'→'||v_cred||' dev='||v_n END;

    -- ── T4: reserva con 2 invitados → devuelve 3 (= débito neto del ledger) ──
    v_rid := (reservar_clase_atomic(v_c2, 2, NULL, NULL, NULL)->>'reserva_id')::uuid;
    SELECT -delta_creditos INTO v_n2 FROM membresia_movimientos WHERE reserva_id = v_rid AND tipo = 'debito';
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem1;
    v_res := cancelar_reserva_atomic(v_rid, 'guests');
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem1;
    SELECT delta_creditos INTO v_n FROM membresia_movimientos WHERE reserva_id = v_rid AND tipo = 'devolucion';
    v_p := v_p || 'T4. reserva +2 invitados: débito 3 → devolución 3 (= 1+invitados_count)'::text;
    v_r := v_r || CASE WHEN v_n2 = 3 AND v_n = 3 AND v_cred = v_cred0 + 3 AND (v_res->>'creditos_devueltos')::int = 3
      THEN '✅ ok' ELSE '❌ debito='||v_n2||' dev='||coalesce(v_n::text,'-')||' cred '||v_cred0||'→'||v_cred END;

    -- ── T5: R5 crédito→crédito (cambio de plan antes de cancelar) → devuelve ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m2::text)::text, true);
    v_rid := (reservar_clase_atomic(v_c1, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_adm::text)::text, true);
    PERFORM recepcion_cambiar_plan(u_m2, t_credB, 'diag cambio', NULL, NULL, true, NULL);
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem2;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m2::text)::text, true);
    v_res := cancelar_reserva_atomic(v_rid, 'cc');
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem2;
    v_p := v_p || 'T5. R5 crédito→crédito: la devolución cae en el tier nuevo (+1)'::text;
    v_r := v_r || CASE WHEN (v_res->>'devuelto')::boolean AND v_cred = v_cred0 + 1
      THEN '✅ ok ('||v_cred0||'→'||v_cred||')' ELSE '❌ res='||v_res::text||' cred '||v_cred0||'→'||v_cred END;

    -- ── T6: R5 crédito→tiempo → NO se acredita (sin_credito) ──
    v_rid := (reservar_clase_atomic(v_c2, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_adm::text)::text, true);
    PERFORM recepcion_cambiar_plan(u_m2, t_tiempo, 'diag a tiempo', NULL, NULL, true, NULL);
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem2;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m2::text)::text, true);
    v_res := cancelar_reserva_atomic(v_rid, 'ct');
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem2;
    SELECT count(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_rid AND tipo = 'devolucion';
    v_p := v_p || 'T6. R5 crédito→tiempo: devuelto=false, sin_credito, saldo NULL, 0 devoluciones'::text;
    v_r := v_r || CASE WHEN NOT (v_res->>'devuelto')::boolean AND v_res->>'devolucion_motivo' = 'sin_credito'
                         AND v_cred0 IS NULL AND v_cred IS NULL AND v_n = 0
      THEN '✅ ok' ELSE '❌ res='||v_res::text||' cred '||coalesce(v_cred0::text,'NULL')||'→'||coalesce(v_cred::text,'NULL')||' dev='||v_n END;

    -- ── T7: R5 híbrido→híbrido → devuelve; híbrido→tiempo → no ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m4::text)::text, true);
    v_rid := (reservar_clase_atomic(v_c1, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    v_rid2 := (reservar_clase_atomic(v_c2, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_adm::text)::text, true);
    PERFORM recepcion_cambiar_plan(u_m4, t_hib2, 'diag hh', NULL, NULL, true, NULL);
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem4;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m4::text)::text, true);
    v_res := cancelar_reserva_atomic(v_rid, 'hh');
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem4;
    v_ok := (v_res->>'devuelto')::boolean AND v_cred = v_cred0 + 1;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_adm::text)::text, true);
    PERFORM recepcion_cambiar_plan(u_m4, t_tiempo, 'diag ht', NULL, NULL, true, NULL);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m4::text)::text, true);
    v_res := cancelar_reserva_atomic(v_rid2, 'ht');
    SELECT creditos_restantes INTO v_cred1 FROM membresias WHERE id = v_mem4;
    SELECT count(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_rid2 AND tipo = 'devolucion';
    v_p := v_p || 'T7. R5 híbrido→híbrido devuelve (+1); híbrido→tiempo no acredita (sin_credito)'::text;
    v_r := v_r || CASE WHEN v_ok AND NOT (v_res->>'devuelto')::boolean AND v_res->>'devolucion_motivo' = 'sin_credito'
                         AND v_cred1 IS NULL AND v_n = 0
      THEN '✅ ok' ELSE '❌ hh_ok='||coalesce(v_ok::text,'null')||' ht='||v_res::text||' dev='||v_n END;

    -- ── T8: D-011 (promovida desde lista de espera) — ADMIN devuelve (R3) ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m3::text)::text, true);
    v_rid := (reservar_clase_atomic(v_c3, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m5::text)::text, true);
    PERFORM anotar_lista_espera(v_c3);
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem5;   -- 19 (débito de la lista)
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m3::text)::text, true);
    PERFORM cancelar_reserva_atomic(v_rid, 'libera');
    SELECT reserva_id, id INTO v_rid2, v_le FROM lista_espera WHERE clase_id = v_c3 AND usuario_id = u_m5 AND status = 'promovido';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_adm::text)::text, true);
    v_res := cancelar_reserva_admin(v_rid2, 'gym', true);
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem5;
    SELECT count(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_rid2 AND lista_espera_id = v_le AND tipo = 'devolucion' AND delta_creditos = 1;
    SELECT count(*) INTO v_n2 FROM auditoria_recepcion WHERE entidad_id = v_rid2;
    v_p := v_p || 'T8. D-011 admin: reserva promovida → devuelve 1 (19→20), ledger con lista_espera_id, 1 bitácora, 1 notif'::text;
    v_r := v_r || CASE WHEN v_rid2 IS NOT NULL AND (v_res->>'devuelto')::boolean AND v_cred0 = 19 AND v_cred = 20 AND v_n = 1 AND v_n2 = 1
                         AND (SELECT count(*) FROM notificaciones WHERE metadata->>'reserva_id' = v_rid2::text AND tipo = 'reserva_cancelada') = 1
      THEN '✅ ok' ELSE '❌ res='||coalesce(v_res::text,'-')||' cred '||v_cred0||'→'||v_cred||' dev='||v_n||' audit='||v_n2 END;

    -- ── T9: D-011 — SOCIO devuelve ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m3::text)::text, true);
    v_rid := (reservar_clase_atomic(v_c4, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m6::text)::text, true);
    PERFORM anotar_lista_espera(v_c4);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m3::text)::text, true);
    PERFORM cancelar_reserva_atomic(v_rid, 'libera');
    SELECT reserva_id INTO v_rid2 FROM lista_espera WHERE clase_id = v_c4 AND usuario_id = u_m6 AND status = 'promovido';
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem6;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m6::text)::text, true);
    v_res := cancelar_reserva_atomic(v_rid2, 'me bajo');
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem6;
    v_p := v_p || 'T9. D-011 socio: reserva promovida → devuelve 1'::text;
    v_r := v_r || CASE WHEN v_rid2 IS NOT NULL AND (v_res->>'devuelto')::boolean AND v_cred = v_cred0 + 1
      THEN '✅ ok' ELSE '❌ res='||coalesce(v_res::text,'-')||' cred '||v_cred0||'→'||v_cred END;

    -- ── T10: clase ya empezada — socio RESERVA_PASADA; admin sí cancela y devuelve ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m1::text)::text, true);
    v_rid := (reservar_clase_atomic(v_c5, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    UPDATE reservas SET slot_inicio = now() - interval '30 minutes', slot_fin = now() + interval '30 minutes' WHERE id = v_rid;
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem1;
    v_err := NULL;
    BEGIN PERFORM cancelar_reserva_atomic(v_rid, 'tarde'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_adm::text)::text, true);
    v_res := cancelar_reserva_admin(v_rid, 'gym pasada', false);
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem1;
    v_p := v_p || 'T10. clase empezada: socio → RESERVA_PASADA; admin → cancelada_admin + devuelve (sin notif si p_notificar=false)'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'RESERVA_PASADA%' AND (v_res->>'devuelto')::boolean AND v_cred = v_cred0 + 1
                         AND (SELECT status FROM reservas WHERE id = v_rid) = 'cancelada_admin'
                         AND (SELECT count(*) FROM notificaciones WHERE metadata->>'reserva_id' = v_rid::text AND tipo = 'reserva_cancelada') = 0
      THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' res='||coalesce(v_res::text,'-')||' cred '||v_cred0||'→'||v_cred END;

    -- ── T11: recepción (wrapper delegante) → éxito + 1 bitácora; repetir → YA_CANCELADA, bitácora sigue en 1 ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m1::text)::text, true);
    v_rid := (reservar_clase_atomic(v_c6, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem1;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_rec::text)::text, true);
    v_res := recepcion_cancelar_reserva(v_rid, 'recep');
    v_err := NULL;
    BEGIN PERFORM recepcion_cancelar_reserva(v_rid, 'recep 2'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem1;
    SELECT count(*) INTO v_n FROM auditoria_recepcion WHERE entidad_id = v_rid;
    v_p := v_p || 'T11. recepcion_cancelar_reserva: devuelve 1, 1 bitácora; repetir → YA_CANCELADA, bitácora=1'::text;
    v_r := v_r || CASE WHEN (v_res->>'devuelto')::boolean AND v_cred = v_cred0 + 1 AND v_err LIKE 'RESERVA_YA_CANCELADA%' AND v_n = 1
      THEN '✅ ok' ELSE '❌ res='||coalesce(v_res::text,'-')||' err='||coalesce(v_err,'(ninguno)')||' audit='||v_n END;

    -- ── T12: sala con mapa + invitado: asiento liberado una vez, re-reservable ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m1::text)::text, true);
    v_rid := (reservar_clase_atomic(v_cmap, 1, NULL, 'L1', '[{"nombre":"Inv","lugar_id":"L2"}]'::jsonb)->>'reserva_id')::uuid;
    v_res := cancelar_reserva_atomic(v_rid, 'mapa');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m3::text)::text, true);
    v_err := NULL;
    BEGIN v_rid2 := (reservar_clase_atomic(v_cmap, 0, NULL, 'L2', NULL)->>'reserva_id')::uuid; EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_n FROM reservas WHERE clase_id = v_cmap AND status IN ('confirmada','completada');
    v_p := v_p || 'T12. mapa: cancelar titular+invitado devuelve 2; asiento del invitado (L2) re-reservable; ocupación 1'::text;
    v_r := v_r || CASE WHEN (v_res->>'creditos_devueltos')::int = 2 AND v_err IS NULL AND v_rid2 IS NOT NULL AND v_n = 1
      THEN '✅ ok' ELSE '❌ res='||coalesce(v_res::text,'-')||' err='||coalesce(v_err,'-')||' ocup='||v_n END;

    -- ── T13: cancelar_clase (parche aditivo) sigue funcionando ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m5::text)::text, true);
    v_rid := (reservar_clase_atomic(v_ccl, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem5;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_adm::text)::text, true);
    v_res := cancelar_clase(v_ccl, NULL, NULL, 'diag');
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem5;
    v_p := v_p || 'T13. cancelar_clase: 1 reserva cancelada_admin, 1 crédito devuelto'::text;
    v_r := v_r || CASE WHEN (v_res->>'reservas_canceladas')::int = 1 AND (v_res->>'creditos_devueltos')::int = 1 AND v_cred = v_cred0 + 1
                         AND (SELECT status FROM reservas WHERE id = v_rid) = 'cancelada_admin'
      THEN '✅ ok' ELSE '❌ res='||coalesce(v_res::text,'-')||' cred '||v_cred0||'→'||v_cred END;

    -- ── T14: autorización intacta — otro socio no puede cancelar ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m1::text)::text, true);
    v_rid := (reservar_clase_atomic(v_c7, 0, NULL, NULL, NULL)->>'reserva_id')::uuid;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m3::text)::text, true);
    v_err := NULL;
    BEGIN PERFORM cancelar_reserva_atomic(v_rid, 'ajeno'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_ok := NULL;
    BEGIN PERFORM cancelar_reserva_admin(v_rid, 'ajeno', true); v_ok := false; EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'NO_AUTORIZADO%'; END;
    v_p := v_p || 'T14. socio ajeno → NO_AUTORIZADO (atomic y admin); reserva sigue confirmada'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'NO_AUTORIZADO%' AND v_ok AND (SELECT status FROM reservas WHERE id = v_rid) = 'confirmada'
      THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' admin='||coalesce(v_ok::text,'null') END;

    -- ── T15: privilegios ──
    v_p := v_p || 'T15. núcleo sin EXECUTE para PUBLIC/anon/authenticated; wrappers siguen ejecutables por authenticated'::text;
    v_r := v_r || CASE WHEN
         NOT has_function_privilege('authenticated', '_cancelar_reserva_core(uuid,uuid,text,text,boolean,boolean)', 'EXECUTE')
     AND NOT has_function_privilege('anon', '_cancelar_reserva_core(uuid,uuid,text,text,boolean,boolean)', 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                     WHERE p.oid = '_cancelar_reserva_core(uuid,uuid,text,text,boolean,boolean)'::regprocedure AND a.grantee = 0)
     AND has_function_privilege('authenticated', 'cancelar_reserva_atomic(uuid,text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'cancelar_reserva_admin(uuid,text,boolean)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'recepcion_cancelar_reserva(uuid,text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'cancelar_clase(uuid,uuid,date,text)', 'EXECUTE')
      THEN '✅ ok' ELSE '❌ privilegios' END;

    RAISE EXCEPTION 'CRI_DIAG_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CRI_DIAG_ROLLBACK' THEN
      v_p := v_p || 'ERROR inesperado'::text;
      v_r := v_r || ('❌ '||SQLERRM);
    END IF;
  END;

  v_p := v_p || 'Z. sin residuo (todo revertido)'::text;
  v_r := v_r || CASE WHEN NOT EXISTS (SELECT 1 FROM tenants WHERE slug = v_slug)
                      AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id IN (a_m1, a_m2, a_m3, a_m4, a_m5, a_m6, a_adm, a_rec))
                      AND NOT EXISTS (SELECT 1 FROM usuarios WHERE auth_id IN (a_m1, a_m2, a_m3, a_m4, a_m5, a_m6, a_adm, a_rec))
                 THEN '✅ ok' ELSE '❌ quedaron fixtures de '||v_slug END;

  FOR i IN 1..array_length(v_p, 1) LOOP
    prueba := v_p[i]; resultado := v_r[i];
    RETURN NEXT;
  END LOOP;
END $$;

SELECT * FROM _diag_cancelar_reserva_integridad();
DROP FUNCTION _diag_cancelar_reserva_integridad();

COMMIT;
