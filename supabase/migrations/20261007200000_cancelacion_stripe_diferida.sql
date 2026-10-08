-- ════════════════════════════════════════════════════════════════════════════
-- CANCELACIÓN STRIPE DIFERIDA (BLOCK 1B + 1C — CANCELLATION SAFETY)
-- ────────────────────────────────────────────────────────────────────────────
-- Problema que cierra: stripe_aplicar_estado_membresia(...,'cancelada',...)
-- finalizaba la membresía (status, créditos, liberar reservas) en el momento
-- del evento Stripe, sin mirar si quedaba vigencia PAGADA por delante.
-- Cancelar la renovación NO equivale a extinguir anticipadamente derechos ya
-- pagados: si queda tiempo pagado, hay que DIFERIR (no tocar nada) hasta que
-- ese tiempo pase de verdad — igual que ya hace el flujo de auto-gestión del
-- socio (cancelar-membresia, cancel_at_period_end).
--
-- Diseño (resumen; ver conversación para el detalle de las 5 gates):
--   1) _stripe_evaluar_cierre_membresia: sustituye, SOLO para nuevo_status=
--      'cancelada', la llamada directa a stripe_aplicar_estado_membresia.
--      Decide con el valor FRESCO de periodo_actual_fin que manda el webhook
--      (nunca con el valor guardado en SALA, que puede estar obsoleto):
--        · Si now() < periodo_actual_fin fresco → DIFERIR: status SIN CAMBIO,
--          créditos/reservas intactos, solo cancelada_at/cancelada_efectiva_at.
--        · Si no (incluye periodo_actual_fin fresco NULL, caso conservador) →
--          FINALIZAR: delega el flip de status + liberar reservas al camino
--          YA CERRADO (stripe_aplicar_estado_membresia, sin tocarlo), y SOLO
--          entonces extingue créditos restantes (ese código nunca lo hacía).
--      NULL fresco (SALA no tiene con certeza el período pagado) es el caso
--      conservador: finaliza el status (Stripe ya dice 'canceled', no hay
--      ambigüedad ahí) pero NO extingue créditos — quedan para revisión
--      manual en vez de perderse. Nunca se usa periodo_actual_fin de SALA
--      para esta decisión: para tier 'creditos' es NULL por diseño (no es
--      señal de "sin vencimiento" en una suscripción Stripe) y para 'hibrido'
--      se computa aparte de Stripe (confirmado leyendo
--      activar_suscripcion_socio); solo 'tipo=tiempo' lo refleja de verdad.
--   2) Reactivación: cuando un evento Stripe aplica 'activa' Y manda
--      cancel_at_period_end=false (Stripe confirma que la cancelación
--      programada se revirtió — ej. el socio la deshizo directo en Stripe,
--      no por el self-serve de SALA que ya limpia estos campos), se limpia
--      cancelada_at/cancelada_efectiva_at. No se usa status='activa' solo:
--      un subscription.updated por otro motivo también trae status='active'
--      con cancel_at_period_end aún true, y limpiar ahí borraría una
--      cancelación programada legítima que sigue en pie. Comparación por
--      IGUALDAD JSONB contra 'false'::jsonb (no cast a boolean con COALESCE):
--      durante la ventana DB-first (migración aplicada, webhook viejo
--      todavía desplegado) p_args NUNCA manda esta clave — con un cast a
--      boolean + COALESCE(...,false), "ausente" se confundía con
--      "explícitamente false" y limpiaba cancelaciones legítimas con
--      cualquier evento 'activa' que llegara en esa ventana. Con igualdad
--      jsonb, clave ausente → NULL → el IF no limpia (seguro); solo limpia
--      cuando el webhook YA desplegado manda el valor explícito false.
--   3) _stripe_finalizar_membresia_diferida (BLOCK 1C): el barrido programado
--      (Netlify) la llama membresía por membresía, SOLO tras confirmar en
--      vivo contra Stripe que sigue cancelada. No depende de orden de evento
--      Stripe (no hay evento real detrás de un barrido) — su propia
--      idempotencia es el lock de fila + re-chequeo de status bajo ese lock,
--      nunca un event_id sintético (eso rompería la garantía de orden de
--      stripe_aplicar_estado_membresia para eventos reales).
--   4) _stripe_es_terminal (hallazgo de la validación adversarial con
--      concurrencia real): porque el barrido finaliza SIN event_id (a
--      propósito, punto 3), su finalize es invisible para la guarda de orden
--      (event_created,event_id) de stripe_aplicar_estado_membresia. Probado en
--      sandbox con dos transacciones reales simultáneas: el barrido finaliza
--      (status→cancelada, créditos a 0) mientras, a la vez, llega un evento
--      'activa' con event_created MÁS NUEVO que el último evento real
--      aplicado — la guarda de orden lo deja pasar igual (desde su punto de
--      vista es un evento nuevo nunca visto) y resucitaba la membresía:
--      status volvía a 'activa' con 0 créditos y cancelada_at en NULL, sin
--      rastro de que la suscripción ya había terminado. Stripe nunca reabre
--      una suscripción cancelada (es un estado terminal; un socio que
--      regresa crea una suscripción NUEVA, con otro id) — un evento que
--      diga 'activa'/'past_due' para la MISMA suscripción que ya está
--      'cancelada'/'expirada' en SALA no debe aplicarse nunca, sin importar
--      qué tan "nuevo" se vea su event_created. stripe_procesar_socio
--      consulta esto ANTES de llamar a stripe_aplicar_estado_membresia en las
--      ramas que no son 'cancelada'; no cambia nada para el caso normal
--      (status aún no terminal).
--
-- Por qué NO se tocan stripe_aplicar_estado_membresia ni la firma de
-- stripe_procesar_socio: cambiar su lista de parámetros crearía una
-- SOBRECARGA nueva en paralelo (CREATE OR REPLACE solo reemplaza con firma
-- IDÉNTICA), dejando viva sin protección la firma vieja. stripe_procesar_socio
-- ya recibe p_args jsonb — toda la información nueva (period_end_fresco,
-- cancel_at_period_end) entra por ahí, sin tocar ninguna firma.
--
-- _audrec_log NO se llama desde esta cadena: todo este flujo corre con
-- service_role (webhook/barrido), donde auth.uid() es NULL —
-- _audrec_log hace RAISE EXCEPTION si no resuelve actor, lo que revertiría
-- TODA la transacción (mismo patrón ya documentado para check_in_por_huella).
-- Ni stripe_aplicar_estado_membresia ni stripe_procesar_socio lo llaman hoy;
-- este bloque mantiene esa misma regla.
--
-- Alcance de esta migración: SOLO funciones de BD. Los cambios de
-- netlify/functions/stripe-webhook (mandar period_end_fresco/
-- cancel_at_period_end) y el nuevo cron de barrido van en el código de la
-- app, no en SQL.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1) Decide diferir vs finalizar una cancelación Stripe ──────────────────
CREATE OR REPLACE FUNCTION _stripe_evaluar_cierre_membresia(
  p_stripe_subscription_id text,
  p_event_created timestamptz,
  p_event_id text,
  p_period_end_fresco timestamptz,
  p_account_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_mem uuid;
  v_cur_status text;
  v_last_at timestamptz;
  v_last_id text;
  v_tenant uuid;
  v_saldo integer;
  v_res jsonb;
BEGIN
  v_mem := _stripe_assert_ownership_sub(p_stripe_subscription_id, p_account_id);
  IF v_mem IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_membership');
  END IF;

  -- Mismo orden canónico R → X → M que usa stripe_aplicar_estado_membresia
  -- para 'cancelada' (este camino la sustituye para esa decisión).
  PERFORM _bloquear_fin_membresias(ARRAY[v_mem]);

  SELECT status, stripe_last_event_at, stripe_last_event_id, tenant_id
  INTO v_cur_status, v_last_at, v_last_id, v_tenant
  FROM membresias WHERE id = v_mem FOR UPDATE;

  -- Misma guarda de orden por objeto que stripe_aplicar_estado_membresia.
  IF v_last_at IS NOT NULL AND (
       p_event_created < v_last_at
       OR (p_event_created = v_last_at AND COALESCE(p_event_id,'') <= COALESCE(v_last_id,''))
     ) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'stale', 'status', v_cur_status);
  END IF;

  IF v_cur_status = 'cancelada' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'ya_cancelada', 'status', v_cur_status);
  END IF;

  IF p_period_end_fresco IS NOT NULL AND now() < p_period_end_fresco THEN
    -- Queda vigencia pagada: DIFERIR. Status, créditos y reservas intactos.
    UPDATE membresias
    SET cancelada_at = COALESCE(cancelada_at, now()),
        cancelada_efectiva_at = p_period_end_fresco,
        stripe_last_event_at = p_event_created,
        stripe_last_event_id = p_event_id,
        updated_at = now()
    WHERE id = v_mem;
    RETURN jsonb_build_object(
      'applied', true, 'membresia_id', v_mem, 'status', v_cur_status,
      'diferido', true, 'diferido_hasta', p_period_end_fresco
    );
  END IF;

  -- No queda vigencia pagada (o no hay evidencia fresca del período): FINALIZA
  -- el status por el camino ya cerrado, bajo el MISMO lock ya tomado arriba.
  v_res := stripe_aplicar_estado_membresia(
    p_stripe_subscription_id, 'cancelada', p_event_created, p_event_id, p_account_id);

  IF COALESCE((v_res->>'applied')::boolean, false) THEN
    SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
    IF p_period_end_fresco IS NOT NULL AND COALESCE(v_saldo, 0) > 0 THEN
      -- Vigencia pagada confirmada y ya vencida: los créditos caducan con ella.
      INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo, created_by)
      VALUES (v_mem, v_tenant, 'expiracion', -v_saldo, 'créditos caducados al vencer la vigencia pagada (Stripe)', NULL);
      UPDATE membresias SET creditos_restantes = 0 WHERE id = v_mem;
    END IF;
    -- p_period_end_fresco NULL: sin evidencia fresca del período pagado.
    -- Conservador: el status ya quedó 'cancelada' (Stripe no tiene ambigüedad
    -- ahí), pero los créditos NO se tocan — quedan para revisión manual en
    -- vez de perderse sin certeza de que el período ya pasó.
  END IF;

  RETURN v_res;
END; $$;

REVOKE ALL ON FUNCTION _stripe_evaluar_cierre_membresia(text, timestamptz, text, timestamptz, text) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION _stripe_evaluar_cierre_membresia(text, timestamptz, text, timestamptz, text) TO service_role;

-- ── 2) Limpia una cancelación diferida cuando Stripe confirma reactivación ──
-- Corrección (validación adversarial): sin el guard de status, un evento de
-- reactivación tardío/duplicado que llega DESPUÉS de que el barrido (1C) ya
-- finalizó esa misma membresía (status='cancelada') limpiaba cancelada_at de
-- todos modos — dejaba status='cancelada' con cancelada_at=NULL, perdiendo el
-- rastro de cuándo se pidió la cancelación en una fila que YA es terminal.
-- Probado en sandbox: sin el guard, status=cancelada/cancelada_at=NULL tras
-- finalizar y luego limpiar en secuencia. Con el guard, limpiar no hace nada
-- sobre una fila ya terminal (cancelada/expirada).
CREATE OR REPLACE FUNCTION _stripe_limpiar_cancelacion_diferida(p_membresia_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE membresias SET cancelada_at = NULL, cancelada_efectiva_at = NULL
  WHERE id = p_membresia_id AND cancelada_at IS NOT NULL
    AND status NOT IN ('cancelada', 'expirada');
$$;

REVOKE ALL ON FUNCTION _stripe_limpiar_cancelacion_diferida(uuid) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION _stripe_limpiar_cancelacion_diferida(uuid) TO service_role;

-- ── 2b) ¿Esta suscripción ya quedó en un status terminal en SALA? ──────────
-- Ver punto 4 del encabezado. Corrección (preflight de producción): la
-- primera versión buscaba por stripe_subscription_id SOLO, sin validar
-- p_account_id — único lookup de esta migración que no reusaba
-- _stripe_assert_ownership_sub, rompiendo el patrón fail-closed que sí siguen
-- _stripe_evaluar_cierre_membresia y stripe_aplicar_estado_membresia. Un
-- stripe_subscription_id jamás colisiona entre tenants (Stripe los genera
-- globalmente únicos), así que no había riesgo de leer la fila de OTRO
-- tenant — pero si el account_id del evento no correspondía al tenant real
-- de esa membresía, esta función absorbía el caso en silencio (false/true
-- según el status) en vez de abortar fuerte con STRIPE_OWNERSHIP, como hace
-- el resto del sistema ante un mismatch. Ahora delega la resolución a
-- _stripe_assert_ownership_sub (mismo comportamiento que todo lookup por
-- stripe_subscription_id en esta base: RAISE en mismatch, NULL = sin
-- membresía ligada todavía, el caller decide).
CREATE OR REPLACE FUNCTION _stripe_es_terminal(p_stripe_subscription_id text, p_account_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mem uuid;
BEGIN
  v_mem := _stripe_assert_ownership_sub(p_stripe_subscription_id, p_account_id);
  IF v_mem IS NULL THEN
    RETURN false;
  END IF;
  RETURN (SELECT status IN ('cancelada', 'expirada') FROM membresias WHERE id = v_mem FOR UPDATE);
END; $$;

REVOKE ALL ON FUNCTION _stripe_es_terminal(text, text) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION _stripe_es_terminal(text, text) TO service_role;

-- ── 3) BLOCK 1C: finaliza una cancelación diferida ya vencida ──────────────
-- La llama el barrido programado (Netlify), membresía por membresía, SOLO
-- tras confirmar EN VIVO contra Stripe que la suscripción sigue cancelada
-- (si Stripe dice que ya no, el barrido llama a _stripe_limpiar_cancelacion_
-- diferida en su lugar — no a esta función). Idempotente por el re-chequeo
-- de status bajo lock, sin depender de ningún event_id.
CREATE OR REPLACE FUNCTION _stripe_finalizar_membresia_diferida(p_membresia_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cur_status text;
  v_cancelada_at timestamptz;
  v_cancelada_efectiva_at timestamptz;
  v_tenant uuid;
  v_saldo integer;
BEGIN
  PERFORM _bloquear_fin_membresias(ARRAY[p_membresia_id]);

  SELECT status, cancelada_at, cancelada_efectiva_at, tenant_id, creditos_restantes
  INTO v_cur_status, v_cancelada_at, v_cancelada_efectiva_at, v_tenant, v_saldo
  FROM membresias WHERE id = p_membresia_id FOR UPDATE;

  IF v_cur_status IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_existe');
  END IF;
  IF v_cur_status IN ('cancelada', 'expirada') THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'ya_finalizada', 'status', v_cur_status);
  END IF;
  IF v_cancelada_at IS NULL OR v_cancelada_efectiva_at IS NULL OR v_cancelada_efectiva_at >= now() THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_corresponde_todavia', 'status', v_cur_status);
  END IF;

  UPDATE membresias SET status = 'cancelada', updated_at = now() WHERE id = p_membresia_id;
  PERFORM _liberar_reservas_membresia(p_membresia_id);

  IF COALESCE(v_saldo, 0) > 0 THEN
    INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo, created_by)
    VALUES (p_membresia_id, v_tenant, 'expiracion', -v_saldo, 'créditos caducados al vencer la vigencia (Stripe, barrido)', NULL);
    UPDATE membresias SET creditos_restantes = 0 WHERE id = p_membresia_id;
  END IF;

  RETURN jsonb_build_object('applied', true, 'membresia_id', p_membresia_id, 'status', 'cancelada');
END; $$;

REVOKE ALL ON FUNCTION _stripe_finalizar_membresia_diferida(uuid) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION _stripe_finalizar_membresia_diferida(uuid) TO service_role;

-- ── 4) Candidatos para el barrido: diferidas aún no finalizadas ────────────
-- Sin columna nueva de dedup (no existe ultimo_reconciliado_at ni se
-- introduce acá): el barrido simplemente vuelve a consultar esto cada corrida
-- y confirma cada caso en vivo contra Stripe antes de actuar.
CREATE OR REPLACE FUNCTION _stripe_candidatos_cierre_diferido()
RETURNS TABLE(membresia_id uuid, stripe_subscription_id text, cancelada_efectiva_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, stripe_subscription_id, cancelada_efectiva_at
  FROM membresias
  WHERE stripe_subscription_id IS NOT NULL
    AND cancelada_at IS NOT NULL
    AND status NOT IN ('cancelada', 'expirada')
    AND cancelada_efectiva_at IS NOT NULL
    AND cancelada_efectiva_at < now()
  ORDER BY cancelada_efectiva_at ASC;
$$;

REVOKE ALL ON FUNCTION _stripe_candidatos_cierre_diferido() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION _stripe_candidatos_cierre_diferido() TO service_role;

-- ── 5) stripe_procesar_socio: reproducido VERBATIM de 20261005140000 salvo
--      las ramas 'estado' y 'sub_estado' (único cambio: cuando nuevo_status=
--      'cancelada', llaman a _stripe_evaluar_cierre_membresia en vez de
--      stripe_aplicar_estado_membresia directo; y tras aplicar 'activa',
--      limpian una cancelación diferida si Stripe confirma reactivación).
--      Firma SIN CAMBIO. Todo lo demás (activar/venta_online/account/
--      reembolso/disputa, variables, RETURN final) es el mismo cuerpo.
CREATE OR REPLACE FUNCTION stripe_procesar_socio(p_event_id text, p_kind text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res jsonb; v_rp jsonb; v_tenant uuid; v_ref jsonb;
  v_pagos uuid[]; v_refs text[]; v_sin_pago boolean := false;
  v_compensaciones jsonb := '[]'::jsonb;
  v_estado_previo text; v_transicion boolean := false;
BEGIN
  IF p_kind = 'activar' THEN
    PERFORM activar_suscripcion_socio(
      (p_args->>'usuario_id')::uuid, (p_args->>'tier_id')::uuid,
      NULLIF(p_args->>'stripe_subscription_id',''), NULLIF(p_args->>'stripe_customer_id',''),
      NULLIF(p_args->>'periodo_fin','')::timestamptz, NULLIF(p_args->>'monto_centavos','')::integer,
      NULLIF(p_args->>'referencia',''), COALESCE(NULLIF(p_args->>'inscripcion_centavos','')::integer,0));

  ELSIF p_kind = 'estado' THEN
    IF p_args->>'nuevo_status' = 'cancelada' THEN
      v_res := _stripe_evaluar_cierre_membresia(
        p_args->>'stripe_subscription_id', (p_args->>'event_created')::timestamptz, p_event_id,
        NULLIF(p_args->>'period_end_fresco','')::timestamptz, NULLIF(p_args->>'account_id',''));
    ELSIF _stripe_es_terminal(p_args->>'stripe_subscription_id', NULLIF(p_args->>'account_id','')) THEN
      -- Ver punto 4 del encabezado: Stripe nunca reabre una cancelación; no
      -- se resucita una membresía ya terminal (sea por el webhook o por el
      -- barrido 1C) con un 'activa'/'past_due' posterior.
      v_res := jsonb_build_object('applied', false, 'reason', 'terminal_no_resucita');
    ELSE
      v_res := stripe_aplicar_estado_membresia(
        p_args->>'stripe_subscription_id', p_args->>'nuevo_status',
        (p_args->>'event_created')::timestamptz, p_event_id, NULLIF(p_args->>'account_id',''));
      IF COALESCE((v_res->>'applied')::boolean, false)
         AND p_args->>'nuevo_status' = 'activa'
         AND (p_args->'cancel_at_period_end') = 'false'::jsonb THEN
        PERFORM _stripe_limpiar_cancelacion_diferida((v_res->>'membresia_id')::uuid);
      END IF;
    END IF;
    IF (v_res->>'reason') = 'no_membership' THEN
      RAISE EXCEPTION 'STRIPE_NO_MEMBERSHIP: sub % sin membresía ligada aún', p_args->>'stripe_subscription_id';
    END IF;

  ELSIF p_kind = 'venta_online' THEN
    PERFORM registrar_venta_online(
      (p_args->>'tenant_id')::uuid, (p_args->>'usuario_id')::uuid,
      NULLIF(p_args->>'sucursal_id','')::uuid, p_args->'items',
      p_args->>'referencia', p_args->>'entrega_tipo', NULLIF(p_args->>'entrega_ubicacion',''));

  ELSIF p_kind = 'account' THEN
    UPDATE tenants
    SET stripe_charges_enabled = (p_args->>'charges')::boolean,
        stripe_details_submitted = (p_args->>'details')::boolean
    WHERE stripe_account_id = p_args->>'account_id';

  -- ── REEMBOLSO: por OBJETO Stripe (igual a C1b) + señal de novedad (W6-D). ──
  ELSIF p_kind = 'reembolso' THEN
    v_refs := _stripe_refs_de_args(p_args);
    v_rp := _stripe_resolver_pagos(p_args->>'account_id', v_refs);
    v_tenant := (v_rp->>'tenant')::uuid;
    v_pagos := ARRAY(SELECT jsonb_array_elements_text(v_rp->'pagos'))::uuid[];
    IF cardinality(v_pagos) > 0 THEN
      FOR v_ref IN
        SELECT r FROM jsonb_array_elements(COALESCE(p_args->'refunds','[]'::jsonb)) AS r
        ORDER BY NULLIF(r->>'created','')::bigint NULLS LAST, r->>'refund_id'
      LOOP
        v_res := _stripe_compensar_objeto(v_tenant, v_pagos,
          NULLIF(v_ref->>'amount','')::integer, v_ref->>'refund_id',
          'Reembolso Stripe '||(v_ref->>'refund_id'));
        -- "nuevo" = compensó Y no fue el camino idempotente (replay del mismo refund.id).
        IF COALESCE((v_res->>'compensado')::boolean, false) AND NOT COALESCE((v_res->>'idempotente')::boolean, false) THEN
          v_compensaciones := v_compensaciones || jsonb_build_object(
            'refund_id', v_ref->>'refund_id', 'monto_centavos', (v_res->>'monto_centavos')::integer);
        END IF;
      END LOOP;
    ELSE
      v_sin_pago := true;
    END IF;

  -- ── DISPUTA: igual a C1b + detección de TRANSICIÓN real de estado (W6-D). ──
  ELSIF p_kind = 'disputa' THEN
    v_refs := _stripe_refs_de_args(p_args);
    v_rp := _stripe_resolver_pagos(p_args->>'account_id', v_refs);
    v_tenant := (v_rp->>'tenant')::uuid;
    v_pagos := ARRAY(SELECT jsonb_array_elements_text(v_rp->'pagos'))::uuid[];
    -- estado ANTES de upsertar: si Stripe reentrega el mismo estado, no es noticia.
    SELECT estado INTO v_estado_previo FROM stripe_disputas WHERE tenant_id = v_tenant AND dispute_id = p_args->>'dispute_id';
    v_transicion := (v_estado_previo IS DISTINCT FROM (p_args->>'estado'));
    INSERT INTO stripe_disputas (tenant_id, dispute_id, charge_id, pago_id, estado, monto_centavos, moneda)
    VALUES (v_tenant, p_args->>'dispute_id', NULLIF(p_args->>'charge_id',''), v_pagos[1],
            p_args->>'estado', NULLIF(p_args->>'amount','')::integer, p_args->>'moneda')
    ON CONFLICT (tenant_id, dispute_id) DO UPDATE
      SET estado = EXCLUDED.estado,
          pago_id = COALESCE(stripe_disputas.pago_id, EXCLUDED.pago_id),
          actualizado_en = now();
    IF cardinality(v_pagos) = 0 THEN
      v_sin_pago := true;
    ELSIF p_args->>'estado' = 'perdida' THEN
      v_res := _stripe_compensar_objeto(v_tenant, v_pagos, NULLIF(p_args->>'amount','')::integer,
        'dp_'||(p_args->>'dispute_id'), 'Contracargo Stripe '||(p_args->>'dispute_id'));
      UPDATE stripe_disputas SET compensado = true, actualizado_en = now()
        WHERE tenant_id = v_tenant AND dispute_id = p_args->>'dispute_id';
    END IF;
    -- 'abierta' → solo persiste (el push de "abierta" lo manda el webhook, best-effort, sin cambios).
    -- 'ganada'  → solo actualiza estado; sin compensación.

  ELSIF p_kind = 'sub_estado' THEN
    IF p_args->>'nuevo_status' = 'cancelada' THEN
      v_res := _stripe_evaluar_cierre_membresia(
        p_args->>'stripe_subscription_id', (p_args->>'event_created')::timestamptz, p_event_id,
        NULLIF(p_args->>'period_end_fresco','')::timestamptz, NULLIF(p_args->>'account_id',''));
    ELSIF _stripe_es_terminal(p_args->>'stripe_subscription_id', NULLIF(p_args->>'account_id','')) THEN
      v_res := jsonb_build_object('applied', false, 'reason', 'terminal_no_resucita');
    ELSE
      v_res := stripe_aplicar_estado_membresia(
        p_args->>'stripe_subscription_id', p_args->>'nuevo_status',
        (p_args->>'event_created')::timestamptz, p_event_id, NULLIF(p_args->>'account_id',''));
      IF COALESCE((v_res->>'applied')::boolean, false)
         AND p_args->>'nuevo_status' = 'activa'
         AND (p_args->'cancel_at_period_end') = 'false'::jsonb THEN
        PERFORM _stripe_limpiar_cancelacion_diferida((v_res->>'membresia_id')::uuid);
      END IF;
    END IF;
    IF (v_res->>'reason') = 'no_membership' THEN
      RAISE EXCEPTION 'STRIPE_NO_MEMBERSHIP: sub % (updated) sin membresía ligada aún', p_args->>'stripe_subscription_id';
    END IF;

  ELSE
    RAISE EXCEPTION 'STRIPE_KIND_INVALIDO: %', p_kind;
  END IF;

  PERFORM _stripe_inbox_processed(p_event_id);
  RETURN jsonb_build_object(
    'ok', true, 'kind', p_kind, 'sin_pago', v_sin_pago, 'tenant_id', v_tenant,
    'pago_id', v_pagos[1], 'compensaciones_nuevas', v_compensaciones,
    'dispute_id', p_args->>'dispute_id', 'estado', p_args->>'estado', 'disputa_transicion', v_transicion
  );
END; $$;
