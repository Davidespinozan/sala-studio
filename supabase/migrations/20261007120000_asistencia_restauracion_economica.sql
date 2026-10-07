-- ════════════════════════════════════════════════════════════════════════════
-- ASISTENCIA · RESTAURACIÓN ECONÓMICA (admin_marcar_asistencia)
-- ────────────────────────────────────────────────────────────────────────────
-- Problema que cierra (ATTENDANCE ECONOMIC INVARIANT):
--   admin_marcar_asistencia solo rechazaba status='completada'. Una reserva
--   cancelada/cancelada_admin/no_show (que ya había recibido su devolución de
--   crédito, o había dejado de ocupar cupo) podía pasar a 'completada' sin:
--     a) volver a debitar el crédito devuelto (asistencia gratis real), ni
--     b) volver a ocupar el cupo/lugar que ya se le había dado a otra persona
--        (sobrecupo fantasma: 2 ocupantes contados para 1 solo cupo).
--   Confirmado en producción (1 caso histórico, revisión pendiente, NO tocado
--   por esta migración) y reproducido/arreglado en sandbox (ver reporte de la
--   sesión de diseño).
--
-- Diseño (aprobado por el owner, decisiones D1–D4):
--   · confirmada → completada sigue siendo el check-in normal: CERO lock
--     nuevo, CERO movimiento de ledger (la reserva ya ocupa cupo y ya tiene
--     su débito activo).
--   · cancelada / cancelada_admin / no_show → completada es una RESTAURACIÓN:
--       - reocupa cupo (headcount: SUM(1+invitados) <= cupo_max; mapa: el
--         lugar original debe seguir libre, con el UNIQUE índice existente
--         como backstop final) bajo el MISMO advisory lock de clase que usan
--         reservar_clase_atomic / _cancelar_reserva_core (clase_lugares:<id>);
--       - re-debita el crédito SOLO si la evidencia inmutable del ledger
--         muestra que esta reserva específica recibió una devolución neta
--         aún no revertida: monto = max(0, débito_original - neto_actual),
--         nunca recalculado desde el tier/invitados actuales;
--       - si hace falta re-debitar: bloquea la membresía ORIGINAL (por id,
--         sin JOIN) y falla cerrado si ya no es elegible (status/tier) o si
--         no alcanza el saldo — jamás cobra a otra membresía, jamás deja
--         saldo negativo, jamás mutación parcial.
--   · Orden de locks R → X → M idéntico al ya establecido en CANCELAR_RESERVA
--     INTEGRITY (89bef31) y MEMBERSHIP-END ECONOMIC INTEGRITY (c73a4e8); X y M
--     solo se piden cuando la restauración realmente los necesita.
--   · Transición final SIGUE guardada por el status de origen (aunque R ya
--     esté tomado) — mismo estilo defensivo que el resto del código base.
--
-- NO reabre ni modifica: check_in_atomic, check_in_manual_atomic,
-- check_in_por_huella, recepcion_marcar_no_show, marcar_no_shows,
-- _cancelar_reserva_core, reservar_clase_atomic, Guest Hardening, ni ningún
-- trigger de capacidad/asiento existente.
--
-- Caso histórico de producción (único, confirmado durante la auditoría):
--   HISTORICAL REFUNDED→COMPLETED CASE = REVIEW PENDING — no se corrige acá.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_marcar_asistencia(p_reserva_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_miembro usuarios;
  v_status_origen text;
  v_es_restauracion boolean;
  v_clase clases;
  v_recurso recursos;
  v_cupo_efectivo integer;
  v_cupos_ocupados integer;
  v_le_origen uuid;
  v_le_mem uuid;
  v_mem_id uuid;
  v_total_debitado integer := 0;
  v_total_devuelto integer := 0;
  v_monto_original integer := 0;
  v_neto_actual integer := 0;
  v_monto_redebitar integer := 0;
  v_mem_status text;
  v_mem_tier uuid;
  v_mem_creditos_actuales integer;
  v_tier_tipo text;
  v_nuevo_saldo integer;
  v_motivo_led text;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden corregir la asistencia';
  END IF;

  -- R: lock de la reserva (idéntico al original; sin JOIN -> sin anomalía EvalPlanQual).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;
  IF v_reserva.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro gimnasio';
  END IF;

  -- #9 aislamiento por sede (recepción solo opera su sede) — sin cambios.
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));

  v_status_origen := v_reserva.status;

  IF v_status_origen = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este socio ya figura como presente';
  END IF;

  IF v_status_origen NOT IN ('confirmada', 'cancelada', 'cancelada_admin', 'no_show') THEN
    RAISE EXCEPTION 'RESERVA_ESTADO_INVALIDO: no se puede marcar asistencia desde el estado %', v_status_origen;
  END IF;

  IF v_reserva.slot_inicio > now() THEN
    RAISE EXCEPTION 'CLASE_NO_INICIADA: Esa clase todavía no empieza; no se puede marcar asistencia';
  END IF;

  -- Restauración = venía de un estado que YA NO ocupaba cupo. 'confirmada'
  -- SIEMPRE cuenta como ocupante en todo el resto del sistema -> jamás es
  -- restauración, y por lo tanto jamás toca X/M (check-in normal intacto).
  v_es_restauracion := v_status_origen IN ('cancelada', 'cancelada_admin', 'no_show');

  IF v_es_restauracion THEN
    -- X: mismo advisory lock de clase que reservar_clase_atomic /
    -- _cancelar_reserva_core (namespace 'clase_lugares:<clase_id>'). Se toma
    -- DESPUÉS de R, ANTES de M.
    IF v_reserva.clase_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || v_reserva.clase_id::text));

      SELECT * INTO v_clase FROM clases WHERE id = v_reserva.clase_id;
      SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;

      -- Pre-chequeo de asiento mapeado (mensaje claro); el índice único
      -- reservas_lugar_unico sigue siendo el backstop final a nivel DB.
      IF v_recurso.layout IS NOT NULL AND v_reserva.lugar_id IS NOT NULL THEN
        IF EXISTS (
          SELECT 1 FROM reservas
          WHERE clase_id = v_reserva.clase_id
            AND lugar_id = v_reserva.lugar_id
            AND status IN ('confirmada', 'completada')
            AND id <> p_reserva_id
        ) THEN
          RAISE EXCEPTION 'LUGAR_OCUPADO: el lugar % de esta clase ya fue tomado por otra reserva', v_reserva.lugar_id;
        END IF;
      END IF;

      SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
      FROM reservas
      WHERE clase_id = v_reserva.clase_id
        AND status IN ('confirmada', 'completada')
        AND id <> p_reserva_id;

      v_cupo_efectivo := CASE
        WHEN v_recurso.layout IS NOT NULL
          THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
        ELSE v_clase.cupo_max
      END;

      IF v_cupos_ocupados + 1 + COALESCE(v_reserva.invitados_count, 0) > v_cupo_efectivo THEN
        RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %); no se puede restaurar la asistencia', v_cupos_ocupados, v_cupo_efectivo;
      END IF;
    END IF;

    -- Procedencia económica inmutable: misma resolución que _cancelar_reserva_core.
    SELECT le.id, le.membresia_id INTO v_le_origen, v_le_mem
    FROM lista_espera le
    WHERE le.reserva_id = p_reserva_id AND le.status = 'promovido'
    LIMIT 1;

    v_mem_id := COALESCE(v_reserva.membresia_id, v_le_mem);
    IF v_mem_id IS NULL THEN
      SELECT mm.membresia_id INTO v_mem_id
      FROM membresia_movimientos mm
      WHERE mm.tipo = 'debito'
        AND (mm.reserva_id = p_reserva_id
             OR (v_le_origen IS NOT NULL AND mm.lista_espera_id = v_le_origen))
      ORDER BY mm.created_at, mm.id
      LIMIT 1;
    END IF;

    IF v_mem_id IS NOT NULL THEN
      SELECT
        COALESCE(SUM(-delta_creditos) FILTER (WHERE tipo = 'debito'), 0),
        COALESCE(SUM(delta_creditos)  FILTER (WHERE tipo = 'devolucion'), 0)
      INTO v_total_debitado, v_total_devuelto
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND (reserva_id = p_reserva_id
             OR (v_le_origen IS NOT NULL AND lista_espera_id = v_le_origen));

      -- Monto original = el PRIMER débito jamás registrado para esta reserva
      -- (evidencia persistida; nunca se recalcula desde 1+invitados actual).
      SELECT COALESCE(-delta_creditos, 0) INTO v_monto_original
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND tipo = 'debito'
        AND (reserva_id = p_reserva_id
             OR (v_le_origen IS NOT NULL AND lista_espera_id = v_le_origen))
      ORDER BY created_at, id
      LIMIT 1;

      v_neto_actual := v_total_debitado - v_total_devuelto;
      v_monto_redebitar := GREATEST(0, v_monto_original - v_neto_actual);
    END IF;

    IF v_monto_redebitar > 0 THEN
      -- M: lock de membresía ORIGINAL por su id, sin JOIN (mismo patrón
      -- anti-EvalPlanQual que _cancelar_reserva_core).
      SELECT m.status, m.tier_id, m.creditos_restantes
        INTO v_mem_status, v_mem_tier, v_mem_creditos_actuales
      FROM membresias m WHERE m.id = v_mem_id FOR UPDATE;

      SELECT t.tipo INTO v_tier_tipo FROM tiers t WHERE t.id = v_mem_tier;

      IF v_mem_status IS NULL
         OR v_mem_status NOT IN ('trialing', 'activa', 'past_due', 'congelada')
         OR v_tier_tipo IS NULL
         OR v_tier_tipo NOT IN ('creditos', 'hibrido') THEN
        RAISE EXCEPTION 'ENTITLEMENT_NO_RESTAURABLE: la membresía original ya no puede recibir este cargo (status=%, tier=%)',
          v_mem_status, v_tier_tipo;
      END IF;

      IF COALESCE(v_mem_creditos_actuales, 0) < v_monto_redebitar THEN
        RAISE EXCEPTION 'SIN_CREDITOS_RESTAURACION: Para restaurar esta asistencia hacen falta % crédito(s) y el socio tiene %',
          v_monto_redebitar, COALESCE(v_mem_creditos_actuales, 0);
      END IF;

      SELECT nombre INTO v_motivo_led FROM clases WHERE id = v_reserva.clase_id;
      v_motivo_led := 'restauración de asistencia tras cancelación (' || COALESCE(v_motivo_led, '') || ')'
        || CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0 THEN ' — ' || p_motivo ELSE '' END;

      -- Fail-closed en saldo insuficiente: _aplicar_credito ya veta saldo negativo
      -- (backstop; el pre-chequeo de arriba ya cubre el caso normal con un error
      -- más específico para la UX de recepción).
      v_nuevo_saldo := _aplicar_credito(
        v_mem_id, -v_monto_redebitar, 'debito', v_motivo_led,
        p_reserva_id, v_le_origen, v_actor
      );
    END IF;
  END IF;

  -- Transición final: guardada por el status de origen aunque R ya esté
  -- tomado (mismo estilo defensivo del resto del código base).
  UPDATE reservas
  SET status = 'completada',
      check_in_at = now(),
      check_in_by = v_actor,
      check_in_method = 'manual',
      updated_at = now()
  WHERE id = p_reserva_id AND status = v_status_origen
  RETURNING * INTO v_reserva;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVA_CONCURRENTEMENTE_MODIFICADA: el estado de la reserva cambió durante la operación';
  END IF;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;

  PERFORM _audrec_log(
    'clase.marcar_asistencia', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
    format('Corrigió la asistencia a "presente" en la clase de %s.%s',
           to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                THEN ' Motivo: ' || p_motivo ELSE '' END),
    jsonb_build_object(
      'motivo', p_motivo,
      'status_origen', v_status_origen,
      'restauracion', v_es_restauracion,
      'creditos_redebitados', v_monto_redebitar
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', p_reserva_id,
    'status_origen', v_status_origen,
    'restauracion', v_es_restauracion,
    'creditos_redebitados', v_monto_redebitar
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_marcar_asistencia(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_marcar_asistencia(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_marcar_asistencia(uuid, text) TO authenticated;
