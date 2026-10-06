-- POST-W6 · #17A-2 — Ghost Capacity Release (membership entitlement termination)
--
-- #17A-1 (commit eafea93f1d723d43803b3344b039081e15869f1b) dejó provenance
-- explícita en reservas/lista_espera (membership | staff_benefit | legacy_unknown).
-- Esta migración usa esa provenance para corregir el P1 original de #17: una
-- membresía que termina de verdad (cancelación inmediata, expiración real, o
-- Stripe confirmando la cancelación) deja de liberar las plazas que ocupaba en
-- reservas futuras cuyo derecho dependía de que esa membresía siguiera vigente.
--
-- Política (aprobada, sin cambios en esta implementación):
--   LIBERAR  reservas 'membership' de la membresía que termina, futuras,
--            SIN débito identificable (ni directo ni vía waitlist).
--   PRESERVAR todo lo demás: staff_benefit, legacy_unknown (las 5,320
--            reservas históricas productivas quedan fuera, sin excepción, sin
--            backfill, sin inferencia), cualquier reserva CON débito (crédito
--            ya consumido), day-pass (tiers.es_pase, membresía entera excluida),
--            congelación/reactivación (nunca disparan esto), y cancelación
--            programada mientras la membresía siga 'activa'.
--
-- Mecanismo: UPDATE guardado (confirmada → cancelada_admin, WHERE status=
-- 'confirmada') — idempotente por construcción, reutiliza el trigger existente
-- de promoción de waitlist sin tocarlo. Nunca reembolsa (por diseño, solo actúa
-- sobre reservas sin débito). No modifica ledger, invitados, ni ninguna regla
-- de staff_benefit.
--
-- Validado en sandbox aislado contra las funciones reales extraídas verbatim:
-- atomicidad confirmada con fallos inyectados, concurrencia sistema-vs-sistema
-- y sistema-vs-cancelación-humana reproducida con conexiones genuinamente
-- concurrentes (ver reporte de la fase de pre-implementation proof). Un hallazgo
-- adyacente y preexistente (cancelar_reserva_atomic/cancelar_reserva_admin sin
-- guardia de status, pudiendo sobrescribir la atribución de una cancelación ya
-- resuelta) queda registrado por separado — no se toca en esta migración.
--
-- Todo-o-nada: BEGIN/COMMIT explícito.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1) PRIMITIVA — ver comentario extenso en el cuerpo de la función.
-- ════════════════════════════════════════════════════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- #17A-2 · _liberar_reservas_membresia — primitiva interna de ghost-capacity
-- release. Server-side, nunca expuesta a cliente (mismo patrón de bloqueo que
-- _promover_entrada: REVOKE de PUBLIC/authenticated/anon). Solo la invocan
-- recepcion_cancelar_membresia, expirar_membresias_vencidas y
-- stripe_aplicar_estado_membresia, en los 3 puntos donde una membresía pierde
-- entitlement REALMENTE (nunca congelar/reactivar/cancelación programada
-- todavía activa).
--
-- Libera únicamente reservas que cumplen TODAS:
--   - entitlement_source = 'membership' (nunca staff_benefit, nunca legacy_unknown)
--   - membresia_id = la membresía que está terminando
--   - status = 'confirmada' AND slot_inicio > now()  (futura, activa)
--   - sin débito identificable, directo (membresia_movimientos.reserva_id) o vía
--     waitlist (membresia_movimientos.lista_espera_id de la entrada que produjo
--     esa reserva) — tier.tipo NUNCA sustituye esta verificación, solo el ledger
--     decide "¿ya se consumió algo?"
--   - la membresía no es tiers.es_pase (day-pass: diseñado para sobrevivir a la
--     clase que cubre; se excluye la membresía ENTERA, nunca pago_unico)
--
-- Transición: confirmada → cancelada_admin, vía UPDATE guardado por
-- WHERE status='confirmada'. Una segunda invocación sobre la misma membresía
-- (webhook duplicado, cron repetido, dos transiciones concurrentes) siempre
-- afecta 0 filas — idempotente por construcción, sin lock nuevo. Reutiliza
-- tal cual el trigger existente reservas_promover_lista_espera (dispara por
-- fila realmente modificada, una sola vez) — no se promueve nada a mano aquí.
--
-- Nunca reembolsa ni crea movimiento de ledger: por construcción solo toca
-- reservas sin débito, así que nunca hay nada que devolver. No borra
-- reserva_invitados (mismo comportamiento que toda otra vía de cancelación
-- existente). No notifica (ver nota de observabilidad abajo).
--
-- Observabilidad: _audrec_log NO es aplicable — exige un actor humano real
-- (auth.uid() → usuarios.rol IN ('recepcionista','admin'), RAISE EXCEPTION si
-- no lo encuentra) y su vocabulario de `accion` es una lista cerrada que no
-- incluye este caso; dos de las tres vías que disparan esta función (cron de
-- expiración, webhook de Stripe) no tienen auth.uid(). Forzarlo abortaría la
-- transacción completa de la membresía. Mínimo sin infraestructura nueva:
-- RAISE NOTICE estructurado, visible en los logs de Postgres de Supabase.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _liberar_reservas_membresia(p_membresia_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_plazas integer;
  v_ids uuid[];
BEGIN
  WITH liberadas AS (
    UPDATE reservas r
    SET status = 'cancelada_admin',
        cancelada_at = now(),
        cancelada_motivo = 'sistema_fin_entitlement: membresía ' || p_membresia_id::text
    WHERE r.membresia_id = p_membresia_id
      AND r.entitlement_source = 'membership'
      AND r.status = 'confirmada'
      AND r.slot_inicio > now()
      AND NOT EXISTS (
        SELECT 1 FROM membresia_movimientos mm
        WHERE mm.tipo = 'debito'
          AND (
            mm.reserva_id = r.id
            OR mm.lista_espera_id = (SELECT le.id FROM lista_espera le WHERE le.reserva_id = r.id)
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM membresias m JOIN tiers t ON t.id = m.tier_id
        WHERE m.id = p_membresia_id AND t.es_pase
      )
    RETURNING r.id, r.invitados_count
  )
  SELECT count(*), COALESCE(sum(1 + invitados_count), 0), COALESCE(array_agg(id), ARRAY[]::uuid[])
  INTO v_count, v_plazas, v_ids
  FROM liberadas;

  IF v_count > 0 THEN
    RAISE NOTICE '#17A-2 sistema_fin_entitlement: membresia=% liberó % reserva(s), % plaza(s) recuperada(s), ids=%',
      p_membresia_id, v_count, v_plazas, v_ids;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION _liberar_reservas_membresia(uuid) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION _liberar_reservas_membresia(uuid) TO service_role;

CREATE OR REPLACE FUNCTION recepcion_cancelar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cancelar la membresía';
  END IF;

  SELECT m.id, m.status, m.tenant_id, u.nombre
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
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
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
$$;

CREATE OR REPLACE FUNCTION expirar_membresias_vencidas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_ids uuid[];
  v_id uuid;
BEGIN
  -- Asiento de expiración de créditos ANTES de ponerlos en 0 (para que el ledger
  -- cuadre). Solo las que caducan con crédito sobrante.
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo, created_by)
  SELECT m.id, m.tenant_id, 'expiracion', -m.creditos_restantes,
         'créditos caducados al vencer la vigencia', NULL
  FROM membresias m
  WHERE m.status IN ('activa', 'trialing', 'past_due')
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
    WHERE status IN ('activa', 'trialing', 'past_due')
      AND stripe_subscription_id IS NULL            -- Stripe → lo maneja el webhook
      AND periodo_actual_fin IS NOT NULL            -- NULL = plan sin vencimiento
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
  -- #17A-2: capturar ids EN LA MISMA sentencia que consume `expiradas` — el CTE
  -- no existe fuera de esta sentencia (corrección obligatoria del diseño original,
  -- que intentaba reusarlo en una sentencia posterior).
  SELECT count(*), COALESCE(array_agg(id), ARRAY[]::uuid[])
  INTO v_count, v_ids
  FROM expiradas;

  -- Ahora sí, YA fuera del WITH, con el array ya capturado: liberar reservas
  -- futuras membership-dependent de cada membresía recién expirada.
  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM _liberar_reservas_membresia(v_id);
  END LOOP;

  RETURN v_count;
END;
$$;

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

COMMIT;
