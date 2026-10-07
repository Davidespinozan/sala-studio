-- ════════════════════════════════════════════════════════════════════════════
-- MEMBERSHIP-END ECONOMIC INTEGRITY · orden canónico de locks R → X → M
-- ────────────────────────────────────────────────────────────────────────────
-- Problemas que cierra (auditados y reproducidos en sandbox):
--   1) Deriva de ledger en expirar_membresias_vencidas: leía creditos_restantes
--      SIN lock en una sentencia (asiento 'expiracion') y bloqueaba/ponía en 0
--      en otra → una devolución/ajuste/renovación concurrente dejaba el ledger
--      descuadrado del saldo.
--   2) Dos corridas del cron solapadas duplicaban el asiento 'expiracion'.
--   3) Deadlock entre una cancelación con devolución (R → X → M) y el cron
--      (M → R → X): la víctima podía ser el lote COMPLETO del día.
--   4) La promoción de lista de espera nunca revalidaba la membresía de la
--      entrada: un socio ya vencido podía terminar con reserva confirmada.
--   5) recepcion_reactivar_membresia podía dejar la membresía 'expirada' sin
--      liberar sus reservas futuras (las otras vías de fin sí lo hacen).
--   6) …y sin caducar sus créditos sobrantes: quedaban vivos para siempre en
--      una membresía 'expirada' (el cron solo procesa las NO expiradas). Ahora
--      caducan en la misma transacción, con el mismo asiento 'expiracion' que
--      deja el cron (regla del dueño: los créditos caducan con la vigencia).
--
-- Diseño (aprobado por el owner):
--   · Orden canónico para TODA operación de fin de membresía, en UNA sola
--     transacción por invocación:
--        R = filas de reservas que la operación puede liberar (por id)
--        X = advisory 'clase_lugares:<clase>' de esas clases + de las clases
--            donde esas membresías esperan en lista (por llave)
--        M = filas de membresías afectadas (por id)
--     Es el MISMO orden que ya usan la cancelación (_cancelar_reserva_core:
--     R → X(trigger) → M) y la reserva (X → M), así que deja de existir ciclo.
--   · El orden vive en UNA primitiva compartida (_bloquear_fin_membresias) que
--     cada caller invoca ANTES de bloquear la membresía. No puede vivir dentro
--     de _liberar_reservas_membresia: esa primitiva corre cuando el caller ya
--     decidió (con M bloqueada) que la membresía terminó; cualquier lock que
--     tomara ahí quedaría después de M. _liberar_reservas_membresia queda
--     INTACTA (misma elegibilidad #17A, sin redefinirla).
--   · Tras bloquear M la primitiva verifica que no apareció ninguna reserva
--     futura ni entrada de lista de esas membresías fuera de lo bloqueado (una
--     reserva/anotación que confirmó justo antes). Si apareció, deshace SOLO
--     sus propios locks (subtransacción) y reintenta; nunca toma R/X después de M.
--   · Las lecturas económicas (saldo a caducar) ocurren DESPUÉS del lock de M.
--   · La promoción revalida la membresía específica de la entrada justo antes
--     de crear la reserva, con el mismo CONTINUE (saltar) que ya usa para
--     usuario inactivo / bloqueado / tier.
--
-- Sin cambios: _cancelar_reserva_core, cancelar_reserva_atomic,
-- cancelar_reserva_admin, recepcion_cancelar_reserva, _liberar_reservas_membresia,
-- el inbox/dedup de eventos Stripe y su guarda de orden (stale), la política
-- de reactivación salvo la liberación al quedar 'expirada'.
--
-- CREATE OR REPLACE conserva los GRANT/REVOKE de las funciones existentes.
-- Este archivo NO contiene self-tests ni diagnósticos que escriban datos.
-- Todo-o-nada.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1) PRIMITIVA DE ORDEN R → X → M ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION _bloquear_fin_membresias(p_membresia_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids     uuid[];
  v_res     uuid[];
  v_keys    bigint[];
  v_k       bigint;
  v_intento integer := 0;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[])
    INTO v_ids
  FROM unnest(p_membresia_ids) AS x
  WHERE x IS NOT NULL;

  IF cardinality(v_ids) = 0 THEN
    RETURN;
  END IF;

  LOOP
    v_intento := v_intento + 1;
    BEGIN
      -- R: superconjunto de lo liberable (futuras, confirmadas, provenance
      -- 'membership' de estas membresías), en orden de id. La elegibilidad
      -- fina (débito, day-pass) la sigue decidiendo _liberar_reservas_membresia.
      SELECT COALESCE(array_agg(s.id ORDER BY s.id), ARRAY[]::uuid[])
        INTO v_res
      FROM (
        SELECT r.id
        FROM reservas r
        WHERE r.membresia_id = ANY (v_ids)
          AND r.entitlement_source = 'membership'
          AND r.status = 'confirmada'
          AND r.slot_inicio > now()
        ORDER BY r.id
        FOR UPDATE OF r
      ) s;

      -- X: llaves de cupo (misma llave que reservar_clase_atomic /
      -- promover_siguiente_en_espera), en orden de llave.
      SELECT COALESCE(array_agg(z.k ORDER BY z.k), ARRAY[]::bigint[])
        INTO v_keys
      FROM (
        SELECT DISTINCT hashtext('clase_lugares:' || u.clase_id::text)::bigint AS k
        FROM (
          SELECT r.clase_id FROM reservas r
          WHERE r.id = ANY (v_res) AND r.clase_id IS NOT NULL
          UNION
          SELECT le.clase_id FROM lista_espera le
          WHERE le.membresia_id = ANY (v_ids) AND le.status = 'esperando'
            AND le.clase_id IS NOT NULL
        ) u
      ) z;

      FOREACH v_k IN ARRAY v_keys LOOP
        PERFORM pg_advisory_xact_lock(v_k);
      END LOOP;

      -- M: membresías, en orden de id.
      PERFORM 1
      FROM (
        SELECT m.id FROM membresias m
        WHERE m.id = ANY (v_ids)
        ORDER BY m.id
        FOR UPDATE OF m
      ) s;

      -- Con M bloqueada nadie puede crear reservas ni anotaciones nuevas para
      -- estas membresías (reservar/anotar bloquean M). Verificar que nada se
      -- coló entre la toma de R y la de M.
      IF EXISTS (
           SELECT 1 FROM reservas r
           WHERE r.membresia_id = ANY (v_ids)
             AND r.entitlement_source = 'membership'
             AND r.status = 'confirmada'
             AND r.slot_inicio > now()
             AND NOT (r.id = ANY (v_res))
         )
         OR EXISTS (
           SELECT 1 FROM lista_espera le
           WHERE le.membresia_id = ANY (v_ids) AND le.status = 'esperando'
             AND le.clase_id IS NOT NULL
             AND NOT (hashtext('clase_lugares:' || le.clase_id::text)::bigint = ANY (v_keys))
         ) THEN
        RAISE EXCEPTION USING ERRCODE = 'SL001', MESSAGE = 'FIN_MEMBRESIA_REINTENTO';
      END IF;

      EXIT;  -- locks R → X → M quedan tomados hasta el fin de la transacción
    EXCEPTION WHEN SQLSTATE 'SL001' THEN
      -- La subtransacción ya soltó SOLO los locks de este intento.
      IF v_intento >= 10 THEN
        RAISE EXCEPTION 'FIN_MEMBRESIA_CONTENCION: no se pudo fijar el conjunto de reservas de la membresía; intenta de nuevo';
      END IF;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION _bloquear_fin_membresias(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION _bloquear_fin_membresias(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION _bloquear_fin_membresias(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION _bloquear_fin_membresias(uuid[]) TO service_role;

-- ── 2) CRON DE EXPIRACIÓN — lote ordenado, economía leída bajo lock ─────────
CREATE OR REPLACE FUNCTION expirar_membresias_vencidas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cand  uuid[];
  v_count integer;
  v_ids   uuid[];
  v_id    uuid;
BEGIN
  -- Candidatas (lectura sin lock: solo decide QUÉ bloquear, nunca montos).
  SELECT COALESCE(array_agg(m.id ORDER BY m.id), ARRAY[]::uuid[])
    INTO v_cand
  FROM membresias m
  WHERE m.status IN ('activa', 'trialing', 'past_due')
    AND m.stripe_subscription_id IS NULL            -- Stripe → lo maneja el webhook
    AND m.periodo_actual_fin IS NOT NULL            -- NULL = plan sin vencimiento
    AND m.periodo_actual_fin < now();

  IF cardinality(v_cand) = 0 THEN
    RETURN 0;
  END IF;

  -- R → X → M de TODO el lote, en orden. Una segunda corrida solapada espera
  -- aquí y luego ve las membresías ya 'expirada' (exactamente-una-vez).
  PERFORM _bloquear_fin_membresias(v_cand);

  -- Asiento de caducidad con el saldo YA bloqueado (re-chequeo de criterio:
  -- una renovación que confirmó antes del lock la saca del lote).
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo, created_by)
  SELECT m.id, m.tenant_id, 'expiracion', -m.creditos_restantes,
         'créditos caducados al vencer la vigencia', NULL
  FROM membresias m
  WHERE m.id = ANY (v_cand)
    AND m.status IN ('activa', 'trialing', 'past_due')
    AND m.stripe_subscription_id IS NULL
    AND m.periodo_actual_fin IS NOT NULL
    AND m.periodo_actual_fin < now()
    AND COALESCE(m.creditos_restantes, 0) > 0;

  WITH expiradas AS (
    UPDATE membresias
    SET status = 'expirada',
        -- Los créditos sobrantes CADUCAN con la vigencia (regla del dueño).
        creditos_restantes = CASE WHEN creditos_restantes IS NOT NULL THEN 0 ELSE NULL END,
        updated_at = now()
    WHERE id = ANY (v_cand)
      AND status IN ('activa', 'trialing', 'past_due')
      AND stripe_subscription_id IS NULL
      AND periodo_actual_fin IS NOT NULL
      AND periodo_actual_fin < now()
    RETURNING id, usuario_id
  ),
  limpiar_cache AS (
    UPDATE usuarios u
    SET membresia_tier = NULL, membresia_activa_id = NULL
    FROM expiradas e
    WHERE u.id = e.usuario_id
      AND u.membresia_activa_id = e.id
    RETURNING u.id
  )
  SELECT count(*), COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[])
    INTO v_count, v_ids
  FROM expiradas;

  -- Todas las membresías del lote ya están 'expirada' antes de liberar nada:
  -- una promoción disparada aquí ve el estado nuevo de cualquier socio del lote.
  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM _liberar_reservas_membresia(v_id);
  END LOOP;

  RETURN v_count;
END;
$$;

-- ── 3) CANCELACIÓN INMEDIATA EN RECEPCIÓN ───────────────────────────────────
-- Idéntica a 20261005260000 salvo: pre-lectura sin lock de la membresía
-- objetivo + _bloquear_fin_membresias antes del lock de M, y verificación de
-- que la membresía bloqueada sigue siendo la más reciente del socio.
CREATE OR REPLACE FUNCTION public.recepcion_cancelar_membresia(p_usuario_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
  v_target uuid;
  v_target_tenant uuid;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cancelar la membresía';
  END IF;

  -- Orden canónico R → X → M: identificar la membresía (sin lock) y bloquear
  -- sus reservas liberables y clases ANTES de la fila de la membresía.
  SELECT m.id, m.tenant_id INTO v_target, v_target_tenant
  FROM membresias m
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_target IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_target_tenant <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;

  PERFORM _bloquear_fin_membresias(ARRAY[v_target]);

  SELECT m.id, m.status, m.tenant_id, u.nombre, m.sucursal_id
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.id <> v_target THEN
    RAISE EXCEPTION 'MEMBRESIA_CAMBIO_CONCURRENTE: la membresía del socio cambió mientras se procesaba; intenta de nuevo';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  IF v_mem.status = 'cancelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_CANCELADA: la membresía ya estaba cancelada';
  END IF;

  UPDATE membresias
  SET status = 'cancelada', cancelada_at = now(), updated_at = now()
  WHERE id = v_mem.id;

  -- Cache: el trigger de W5-B también lo limpia; se mantiene por robustez.
  UPDATE usuarios
  SET membresia_tier = NULL, membresia_activa_id = NULL
  WHERE id = p_usuario_id;

  -- #17A-2: la membresía perdió entitlement de verdad (cancelación inmediata) →
  -- liberar sus reservas futuras membership-dependent sin débito.
  PERFORM _liberar_reservas_membresia(v_mem.id);

  PERFORM _audrec_log(
    'membresia.cancelar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Canceló la membresía. Motivo: %s', p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', v_mem.status)
  );

  RETURN jsonb_build_object('success', true, 'status', 'cancelada');
END;
$function$;

-- ── 4) REACTIVACIÓN EN RECEPCIÓN (T2) ───────────────────────────────────────
-- Idéntica a 20261005260000 salvo: orden R → X → M antes del lock de M, y si
-- la reactivación deja la membresía 'expirada' (el vencimiento extendido ya
-- pasó) llama a la misma primitiva de liberación que las demás vías de fin y
-- caduca sus créditos sobrantes igual que el cron (asiento 'expiracion' con
-- -saldo leído bajo el lock de M + saldo en 0, en el mismo UPDATE del status).
-- Quedar 'expirada' aquí significa que la vigencia ya había pasado ANTES de la
-- pausa (fin <= congelada_at): es el mismo evento que el cron habría caducado
-- si la membresía no hubiera estado congelada (el cron salta 'congelada').
-- La política de reactivación (extensión, status final, bitácora) no cambia.
CREATE OR REPLACE FUNCTION public.recepcion_reactivar_membresia(p_usuario_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
  v_extension interval;
  v_dias numeric;
  v_nuevo_fin timestamptz;
  v_status_final text;
  v_target uuid;
  v_target_tenant uuid;
  v_caducados integer;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para reactivar';
  END IF;

  -- Orden canónico R → X → M (ver recepcion_cancelar_membresia).
  SELECT m.id, m.tenant_id INTO v_target, v_target_tenant
  FROM membresias m
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_target IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_target_tenant <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;

  PERFORM _bloquear_fin_membresias(ARRAY[v_target]);

  SELECT m.id, m.status, m.tenant_id, m.periodo_actual_fin, m.congelada_at, u.nombre, m.sucursal_id,
         m.creditos_restantes
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.id <> v_target THEN
    RAISE EXCEPTION 'MEMBRESIA_CAMBIO_CONCURRENTE: la membresía del socio cambió mientras se procesaba; intenta de nuevo';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  IF v_mem.status <> 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_ACTIVA: la membresía no estaba pausada';
  END IF;

  v_extension := CASE
    WHEN v_mem.congelada_at IS NOT NULL THEN now() - v_mem.congelada_at
    ELSE interval '0'
  END;
  v_dias := round(extract(epoch FROM v_extension) / 86400.0, 1);

  v_nuevo_fin := CASE
    WHEN v_mem.periodo_actual_fin IS NOT NULL THEN v_mem.periodo_actual_fin + v_extension
    ELSE NULL
  END;
  v_status_final := CASE
    WHEN v_nuevo_fin IS NOT NULL AND v_nuevo_fin <= now() THEN 'expirada'
    ELSE 'activa'
  END;

  -- Quedó 'expirada' → los créditos sobrantes CADUCAN con la vigencia (mismo
  -- asiento y signo que expirar_membresias_vencidas). El saldo es el de la fila
  -- ya bloqueada (FOR UPDATE OF m arriba). El re-chequeo status='congelada'
  -- hace imposible un segundo asiento para esta misma transición: tras el
  -- UPDATE de abajo la fila ya no está congelada y su saldo es 0.
  v_caducados := CASE
    WHEN v_status_final = 'expirada' THEN GREATEST(COALESCE(v_mem.creditos_restantes, 0), 0)
    ELSE 0
  END;
  IF v_caducados > 0 THEN
    INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo, created_by)
    SELECT m.id, m.tenant_id, 'expiracion', -m.creditos_restantes,
           'créditos caducados al vencer la vigencia (reactivada ya vencida)', get_my_user_id()
    FROM membresias m
    WHERE m.id = v_mem.id
      AND m.status = 'congelada'
      AND m.creditos_restantes = v_caducados;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MEMBRESIA_CAMBIO_CONCURRENTE: la membresía del socio cambió mientras se procesaba; intenta de nuevo';
    END IF;
  END IF;

  UPDATE membresias
  SET status = v_status_final,
      periodo_actual_fin = v_nuevo_fin,
      congelada_at = NULL,
      creditos_restantes = CASE
        WHEN v_status_final = 'expirada' AND creditos_restantes IS NOT NULL THEN 0
        ELSE creditos_restantes
      END,
      updated_at = now()
  WHERE id = v_mem.id;

  -- T2: quedó terminada de verdad → misma liberación que las otras vías de fin.
  IF v_status_final = 'expirada' THEN
    PERFORM _liberar_reservas_membresia(v_mem.id);
  END IF;

  PERFORM _audrec_log(
    'membresia.reactivar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Reactivó la membresía (se extendió el vencimiento %s días por la pausa)%s. Motivo: %s',
           v_dias,
           CASE WHEN v_status_final = 'expirada' THEN ' — quedó VENCIDA (ya estaba vencida al reactivar)' ELSE '' END,
           p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', 'congelada',
                       'status_final', v_status_final, 'dias_extendidos', v_dias,
                       'creditos_caducados', v_caducados)
  );

  RETURN jsonb_build_object('success', true, 'status', v_status_final, 'dias_extendidos', v_dias);
END;
$function$;

-- ── 5) STRIPE (función de BD) ───────────────────────────────────────────────
-- Idéntica a 20261005240000 salvo: cuando el evento termina la membresía
-- ('cancelada'), R → X → M antes del lock de M. Ownership, guarda de orden
-- (stale) y campos escritos sin cambios. El inbox/dedup por event-id vive en
-- el webhook y en stripe_event_inbox: no se toca.
CREATE OR REPLACE FUNCTION stripe_aplicar_estado_membresia(
  p_stripe_subscription_id text,
  p_nuevo_status text,
  p_event_created timestamptz,
  p_event_id text,
  p_account_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mem uuid; v_cur_status text; v_last_at timestamptz; v_last_id text;
BEGIN
  IF p_nuevo_status NOT IN ('activa','past_due','cancelada') THEN
    RAISE EXCEPTION 'STRIPE_STATUS_INVALIDO: % no es un status Stripe-driven', p_nuevo_status;
  END IF;

  -- Ownership inequívoco (fail-closed ante mismatch). NULL = sin membresía ligada.
  v_mem := _stripe_assert_ownership_sub(p_stripe_subscription_id, p_account_id);
  IF v_mem IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_membership');
  END IF;

  -- Fin de membresía → orden canónico R → X → M antes del lock de M.
  IF p_nuevo_status = 'cancelada' THEN
    PERFORM _bloquear_fin_membresias(ARRAY[v_mem]);
  END IF;

  -- Lock + estado/orden actuales.
  SELECT status, stripe_last_event_at, stripe_last_event_id
  INTO v_cur_status, v_last_at, v_last_id
  FROM membresias WHERE id = v_mem FOR UPDATE;

  -- Orden por objeto: aplicar solo si (created, event_id) > (last_at, last_id). Idempotente.
  IF v_last_at IS NOT NULL AND (
       p_event_created < v_last_at
       OR (p_event_created = v_last_at AND COALESCE(p_event_id,'') <= COALESCE(v_last_id,''))
     ) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'stale', 'status', v_cur_status);
  END IF;

  -- Escribe SOLO campos cuya autoridad es Stripe (status + orden + cancelada_at).
  -- NO toca créditos ni entitlement. El UPDATE dispara W5-B (sync cache) y pasa W5-C
  -- por correr como owner (service_role/DEFINER).
  UPDATE membresias
  SET status = p_nuevo_status,
      cancelada_at = CASE WHEN p_nuevo_status = 'cancelada' THEN COALESCE(cancelada_at, now()) ELSE cancelada_at END,
      stripe_last_event_at = p_event_created,
      stripe_last_event_id = p_event_id,
      updated_at = now()
  WHERE id = v_mem;

  -- #17A-2: solo cuando Stripe realmente termina la membresía (nunca para
  -- 'activa'/'past_due', que conservan entitlement según las reglas actuales).
  IF p_nuevo_status = 'cancelada' THEN
    PERFORM _liberar_reservas_membresia(v_mem);
  END IF;

  RETURN jsonb_build_object('applied', true, 'membresia_id', v_mem, 'status', p_nuevo_status);
END; $$;

-- ── 6) PROMOCIÓN DE LISTA DE ESPERA (T1) ────────────────────────────────────
-- Idéntica a 20261006120000 salvo UN chequeo antes de _promover_entrada: la
-- membresía específica de la que depende la entrada (lista_espera.membresia_id,
-- provenance 'membership') debe seguir viva. Si terminó ('expirada',
-- 'cancelada', …) o su vigencia ya pasó (la que el cron va a expirar: sin
-- Stripe, no congelada, periodo_actual_fin <= now), se SALTA con el mismo
-- CONTINUE que usuario inactivo / bloqueado / tier: la entrada queda
-- 'esperando' y el bucle sigue con el siguiente candidato (el lugar no se
-- desperdicia). 'congelada' no cuenta como terminada (igual que en la
-- liberación #17A). Lectura fresca sin lock: toda vía de fin bloquea la
-- llave de cupo de las clases donde la membresía espera ANTES de cambiarla,
-- así que mientras esta promoción tiene esa llave nadie la está terminando.
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

    -- T1: revalidar la membresía de la que depende ESTA entrada justo antes de
    -- volverla una reserva confirmada. Misma semántica de salto (CONTINUE).
    IF v_entry.entitlement_source = 'membership'
       AND v_entry.membresia_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM membresias m
         WHERE m.id = v_entry.membresia_id
           AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
           AND NOT (
             m.status <> 'congelada'
             AND m.stripe_subscription_id IS NULL
             AND m.periodo_actual_fin IS NOT NULL
             AND m.periodo_actual_fin <= v_now
           )
       ) THEN
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
  'Promueve en orden FIFO desde la lista de espera hasta llenar la capacidad real (personas = 1 + invitados; capacidad = asientos del mapa o cupo_max), recalculando tras cada promoción. Toma el lock clase_lugares de la clase (misma llave que reservar_clase_atomic). Salta entradas no promovibles (usuario inactivo/bloqueado, tier, o membresía de la entrada ya terminada/vencida); re-verifica que cada entrada siga esperando. Si el siguiente ya tiene reserva en la clase, cierra su entrada DEVOLVIENDO el crédito (fix M5). Devuelve el primer usuario promovido o NULL.';

COMMIT;

-- Verificación opcional, SOLO LECTURA (no escribe nada), para correr aparte
-- después de aplicar:
--   SELECT proname, prosecdef FROM pg_proc
--   WHERE proname IN ('_bloquear_fin_membresias','expirar_membresias_vencidas',
--                     'recepcion_cancelar_membresia','recepcion_reactivar_membresia',
--                     'stripe_aplicar_estado_membresia','promover_siguiente_en_espera');
--   SELECT has_function_privilege('authenticated','_bloquear_fin_membresias(uuid[])','EXECUTE'); -- esperado: false
