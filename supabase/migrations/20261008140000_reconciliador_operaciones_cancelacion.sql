-- ════════════════════════════════════════════════════════════════════════════
-- RECONCILIADOR DURABLE DE OPERACIONES DE CANCELACIÓN STRIPE (BLOCK 2B)
-- ────────────────────────────────────────────────────────────────────────────
-- Alcance: SOLO la recuperación durable de operaciones que quedaron
-- 'en_ejecucion' por fallos/timeouts/caídas de proceso. Nada del flujo
-- interactivo de Netlify (2C) va acá. No se toca ni se redefine ninguna
-- función de BLOCK 2A (iniciar_operacion_cancelacion/
-- confirmar_operacion_cancelacion quedan exactamente como están) ni de
-- BLOCK1A/1B+1C.
--
-- Gate de 2A (release de esta conversación): revisado el archivo completo de
-- 20261008100000 — firmas, grants, RLS, orden de locks y las dos funciones.
-- Sin P0/P1. Una precisión necesaria para 2B: confirmar_operacion_cancelacion
-- exige que el actor que confirma sea el MISMO que inició (auth.uid() real) —
-- el reconciliador corre con service_role (sin sesión de usuario), así que
-- NUNCA puede llamarla (fallaría en NO_AUTORIZADO: actor no resuelto). Por
-- eso 2B necesita una función de resolución PROPIA
-- (reconciliar_operacion_cancelacion), nunca reusar confirmar_operacion_
-- cancelacion con un bypass — mantiene 2A sin tocar y evita abrir una puerta
-- de "confirmar sin JWT" en la función que sí usan socios/staff.
--
-- Diseño (de las rondas de diseño previas):
--   1) _reconciliador_reclamar_candidatos: exclusión real entre
--      reconciliadores concurrentes con dos capas:
--        - FOR UPDATE SKIP LOCKED sobre las filas candidatas: dos corridas
--          GENUINAMENTE simultáneas del cron se reparten candidatos
--          disjuntos, nunca el mismo.
--        - reconciliador_ultima_revision como "lease" de 90s: una corrida
--          que empieza SEGUNDOS después de que otra ya reclamó (no
--          simultánea, pero solapada en el tiempo que tarda Netlify en
--          llamar a Stripe) no vuelve a reclamar lo mismo mientras el lease
--          siga vigente.
--      Solo mira operaciones con más de 2 minutos de antigüedad — margen
--      generoso frente al tiempo de respuesta síncrono normal de Stripe.
--   2) reconciliar_operacion_cancelacion: nunca confía en el payload de
--      ningún webhook ni en la intención original de la operación — decide
--      ÚNICAMENTE con la lectura EN VIVO que le pasa Netlify (p_lectura_viva,
--      obtenida con stripe.subscriptions.retrieve, nunca con el resultado de
--      un update()). Exige DOS lecturas consecutivas IDÉNTICAS (guardadas en
--      reconciliador_ultima_lectura) antes de resolver — si la lectura actual
--      difiere de la anterior, NO concluye todavía: guarda y espera la
--      próxima corrida. Esto es lo que impide que una operación vieja
--      sobrescriba una decisión posterior (si algo cambió entre dos visitas,
--      el cambio se detecta como inestabilidad, no se ignora).
--   3) Terminalidad: si la membresía ya es 'cancelada'/'expirada' cuando se
--      resuelve, la operación se marca reconciliada igual (ya no hay nada
--      que reconciliar) pero jamás se escribe cancelada_at/efectiva_at sobre
--      ella — nunca la reactiva.
--   4) La escritura del mirror SOLO ocurre si la lectura viva de Stripe
--      efectivamente coincide con la intención de la operación
--      ('programar' + cancel_at_period_end=true, o 'retirar' +
--      cancel_at_period_end=false). Si Stripe en vivo muestra lo contrario
--      (alguien más lo revirtió mientras tanto), la operación se cierra como
--      reconciliada SIN tocar la membresía — nunca sobrescribe una decisión
--      más reciente de otro actor.
--
-- Nada de esto toca créditos, reservas ni ledger. No se modifica
-- auditoria_recepcion otra vez (ya tiene sus valores desde 2A). No se llama
-- _audrec_log desde el reconciliador (corre con service_role, auth.uid() NULL
-- — mismo principio ya establecido para BLOCK1B/1C y el barrido 1C: el
-- reconciliador reporta a Sentry, no a la bitácora de staff).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1) Reclamar candidatos (exclusión real entre reconciliadores) ──────────
CREATE OR REPLACE FUNCTION _reconciliador_reclamar_candidatos(p_limite integer DEFAULT 25)
RETURNS TABLE(
  operacion_id uuid, membresia_id uuid, tenant_id uuid, accion text,
  stripe_subscription_id text, lectura_previa jsonb
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(x.id), ARRAY[]::uuid[]) INTO v_ids
  FROM (
    SELECT id FROM stripe_operaciones_cancelacion
    WHERE estado = 'en_ejecucion'
      AND creada_at < now() - interval '2 minutes'
      AND (reconciliador_ultima_revision IS NULL OR reconciliador_ultima_revision < now() - interval '90 seconds')
    ORDER BY creada_at ASC
    LIMIT GREATEST(p_limite, 1)
    FOR UPDATE SKIP LOCKED
  ) x;

  IF cardinality(v_ids) = 0 THEN
    RETURN;
  END IF;

  UPDATE stripe_operaciones_cancelacion
  SET reconciliador_ultima_revision = now()
  WHERE id = ANY(v_ids);

  RETURN QUERY
  SELECT op.id, op.membresia_id, op.tenant_id, op.accion, m.stripe_subscription_id, op.reconciliador_ultima_lectura
  FROM stripe_operaciones_cancelacion op
  JOIN membresias m ON m.id = op.membresia_id
  WHERE op.id = ANY(v_ids);
END; $$;

REVOKE ALL ON FUNCTION _reconciliador_reclamar_candidatos(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _reconciliador_reclamar_candidatos(integer) TO service_role;

-- ── 2) Resolver una operación con una lectura en vivo de Stripe ────────────
CREATE OR REPLACE FUNCTION reconciliar_operacion_cancelacion(
  p_operacion_id uuid,
  p_lectura_viva jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_op RECORD;
  v_mem_status text;
  v_period_end_fresco timestamptz;
BEGIN
  SELECT * INTO v_op FROM stripe_operaciones_cancelacion WHERE id = p_operacion_id FOR UPDATE;
  IF v_op.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'operacion_no_existe');
  END IF;
  IF v_op.estado <> 'en_ejecucion' THEN
    RETURN jsonb_build_object('ok', true, 'idempotente', true, 'estado', v_op.estado);
  END IF;

  -- Doble lectura estable: si difiere de la visita anterior, todavía no es
  -- seguro concluir nada — se guarda y se espera la PRÓXIMA corrida del cron.
  IF v_op.reconciliador_ultima_lectura IS NULL OR v_op.reconciliador_ultima_lectura IS DISTINCT FROM p_lectura_viva THEN
    UPDATE stripe_operaciones_cancelacion
    SET reconciliador_ultima_lectura = p_lectura_viva, reconciliador_ultima_revision = now()
    WHERE id = p_operacion_id;
    RETURN jsonb_build_object('ok', true, 'estable', false);
  END IF;

  -- Dos lecturas consecutivas CONCUERDAN: se resuelve.
  v_period_end_fresco := NULLIF(p_lectura_viva->>'current_period_end', '')::timestamptz;

  UPDATE stripe_operaciones_cancelacion
  SET estado = 'reconciliada', resuelto_por = 'reconciliador', reconciliada_at = now(),
      resultado = jsonb_build_object('lectura', p_lectura_viva)
  WHERE id = p_operacion_id;

  SELECT status INTO v_mem_status FROM membresias WHERE id = v_op.membresia_id FOR UPDATE;
  IF v_mem_status IN ('cancelada', 'expirada') THEN
    -- Ya terminal (1C, o una terminación administrativa, la cerró mientras
    -- tanto): la operación queda reconciliada, la membresía NUNCA se toca ni
    -- se "reactiva".
    RETURN jsonb_build_object('ok', true, 'aplicado', false, 'membresia_terminal', true);
  END IF;

  -- La escritura SOLO ocurre si Stripe en vivo efectivamente confirma la
  -- intención de ESTA operación. Si otra acción más reciente ya la revirtió
  -- (Stripe muestra lo contrario), no se sobrescribe nada.
  IF v_op.accion = 'programar' THEN
    IF COALESCE((p_lectura_viva->>'cancel_at_period_end')::boolean, false) THEN
      UPDATE membresias
      SET cancelada_at = COALESCE(cancelada_at, now()), cancelada_efectiva_at = v_period_end_fresco
      WHERE id = v_op.membresia_id;
      RETURN jsonb_build_object('ok', true, 'aplicado', true, 'membresia_id', v_op.membresia_id);
    END IF;
  ELSE
    IF NOT COALESCE((p_lectura_viva->>'cancel_at_period_end')::boolean, true) THEN
      UPDATE membresias SET cancelada_at = NULL, cancelada_efectiva_at = NULL
      WHERE id = v_op.membresia_id;
      RETURN jsonb_build_object('ok', true, 'aplicado', true, 'membresia_id', v_op.membresia_id);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'aplicado', false, 'motivo', 'stripe_no_confirma_la_intencion');
END; $$;

REVOKE ALL ON FUNCTION reconciliar_operacion_cancelacion(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reconciliar_operacion_cancelacion(uuid, jsonb) TO service_role;
