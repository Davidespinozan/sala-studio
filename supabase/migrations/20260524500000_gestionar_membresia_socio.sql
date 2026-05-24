-- ============================================================================
-- Membresías Prepago — Fase 4: alta/renovación manual desde el admin
-- ============================================================================
-- RPC SECURITY DEFINER que cierra el círculo operativo:
--   socio paga → admin gestiona membresía → socio reserva.
--
-- Reemplaza el "atajo viejo" (CambiarPlanModal con UPDATE directo a
-- usuarios.membresia_tier). El atajo solo movía el slug de referencia y
-- dejaba la fila en `membresias` desincronizada — el gate del backend
-- (Fase 2A.2) terminaba bloqueando al socio con SIN_MEMBRESIA.
--
-- AUTORIZACIÓN — solo staff (is_recepcionista() = admin + recepción) del
-- mismo tenant que el socio. Un socio NO puede auto-renovarse. El tier
-- debe pertenecer al mismo tenant que el socio (cross-tenant rechazado).
--
-- LÓGICA DE FECHAS:
--   - Sin membresía vigente previa            → ALTA: fin = now + tier.duracion_dias.
--   - Vigente y MISMO TIPO                    → RENOVACIÓN: fin = fin_anterior + duracion (suma).
--   - Vencida o sin fin, MISMO TIPO           → RENOVACIÓN_DESDE_HOY: fin = now + duracion.
--   - Tier nuevo con duracion_dias=NULL       → fin = NULL (créditos puros sin vencimiento).
--
-- LÓGICA DE CRÉDITOS (regla suma/reset por tipo, per spec):
--   - Mismo tipo (creditos→creditos, hibrido→hibrido)
--                                             → SUMA: saldo + clases_incluidas.
--   - Cambio de tipo (creditos↔hibrido, tiempo↔créditos, etc.)
--                                             → RESETEA: saldo = clases_incluidas del nuevo
--                                                        (o NULL si nuevo es tiempo).
--   - Tier nuevo tipo=tiempo                  → saldo = NULL (sin créditos que llevar).
--
-- LEDGER — escribe UN movimiento 'alta' con delta_creditos = neto:
--    delta = COALESCE(nuevo_saldo,0) - COALESCE(saldo_anterior,0).
-- Esa es la mutación efectiva. Para cambio de tipo el delta puede ser
-- positivo o negativo (los créditos viejos "se pierden" en el cambio —
-- es semántica de "alta nueva"). El motivo describe el caso.
--
-- SINCRONIZACIÓN — denormalized caches en `usuarios`:
--    membresia_tier   = tier.slug del nuevo tier  (lo USA el gate hoy)
--    membresia_activa_id = id de la membresía resultante
-- Sin esto, el gate va a rechazar con TIER_NO_PERMITIDO porque
-- recurso.tiers_permitidos[] se chequea contra usuarios.membresia_tier.
-- D-014 anotado: migrar el gate para leer tier vía JOIN y eliminar este
-- cache. Mientras tanto, este RPC lo mantiene en sincronía.
--
-- STATUS DEL USUARIO — caso "socio nuevo": admin-create-user setea
-- usuarios.status='pendiente_pago' cuando rol='miembro'. Si el RPC ve
-- pendiente_pago, lo pasa a 'activo' (sino el gate tira USUARIO_INACTIVO
-- aunque la membresía sea válida). Otros status (suspendido / cancelado
-- / pendiente_onboarding) NO se tocan — esos tienen sus propias rutas.
--
-- ATOMICIDAD — todo en la misma transacción del SECURITY DEFINER:
--    [UPDATE/INSERT membresia] + [INSERT movimiento] + [UPDATE usuarios].
-- FOR UPDATE sobre la fila vigente si existe → impide doble-renovación
-- por race (dos pestañas del admin abriendo el modal a la vez).
--
-- STATUS DE LA MEMBRESÍA RESULTANTE — siempre 'activa'. Eso reactiva
-- implícitamente una pausada ('congelada'): renovar = volver a estar al día.
-- ============================================================================

CREATE OR REPLACE FUNCTION gestionar_membresia_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_actor_tenant_id uuid;
  v_socio usuarios;
  v_tier tiers;
  v_now timestamptz := now();

  -- Membresía anterior (si hay una vigente para el socio)
  v_anterior_id uuid;
  v_anterior_fin timestamptz;
  v_anterior_saldo integer;
  v_anterior_tier_tipo text;
  v_existe_anterior boolean := false;
  v_mismo_tipo boolean := false;

  -- Resultantes
  v_nuevo_fin timestamptz;
  v_nuevo_saldo integer;
  v_modo text;            -- 'alta' | 'renovacion' | 'renovacion_desde_hoy' | 'cambio_de_tipo'
  v_delta_creditos integer;
  v_membresia_id uuid;
  v_motivo_final text;
BEGIN
  -- ── Actor + autorización ───────────────────────────────────────────────
  v_actor_id := get_my_user_id();
  v_actor_tenant_id := get_my_tenant_id();
  IF v_actor_id IS NULL OR v_actor_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff (admin/recepción) puede gestionar membresías';
  END IF;

  -- ── Socio objetivo ─────────────────────────────────────────────────────
  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;
  IF v_socio.tenant_id <> v_actor_tenant_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El socio no pertenece a tu gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Solo se pueden asignar membresías a usuarios con rol miembro';
  END IF;

  -- ── Tier objetivo ──────────────────────────────────────────────────────
  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: El tier no existe';
  END IF;
  IF v_tier.tenant_id <> v_socio.tenant_id THEN
    RAISE EXCEPTION 'TIER_TENANT_INVALIDO: El tier no pertenece al mismo gimnasio que el socio';
  END IF;
  IF NOT v_tier.activo THEN
    RAISE EXCEPTION 'TIER_INACTIVO: El tier no está activo. Activalo desde Planes antes de asignarlo';
  END IF;

  -- ── Localizar membresía vigente del socio (lock anti-race) ─────────────
  -- Incluye 'congelada' porque renovar reactiva una pausada (la pone 'activa').
  SELECT m.id, m.periodo_actual_fin, m.creditos_restantes, t.tipo
  INTO v_anterior_id, v_anterior_fin, v_anterior_saldo, v_anterior_tier_tipo
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  v_existe_anterior := v_anterior_id IS NOT NULL;
  v_mismo_tipo := v_existe_anterior AND v_anterior_tier_tipo = v_tier.tipo;

  -- ── Calcular nuevo fin y saldo según el caso ───────────────────────────
  IF NOT v_existe_anterior THEN
    -- ALTA nueva (incluye el caso "socio recién creado por admin-create-user
    -- que nunca tuvo membresía")
    v_modo := 'alta';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;

  ELSIF v_mismo_tipo THEN
    -- Renovación / recarga (mismo tipo)
    IF v_tier.duracion_dias IS NULL THEN
      -- Tier nuevo es "eterno" (créditos puros sin vencimiento)
      v_nuevo_fin := NULL;
      v_modo := 'renovacion';
    ELSIF v_anterior_fin IS NOT NULL AND v_anterior_fin > v_now THEN
      -- Vigente: suma a partir del fin actual (no pierde días que le quedaban)
      v_nuevo_fin := v_anterior_fin + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion';
    ELSE
      -- Vencida (o sin fin previo) y tier nuevo SÍ tiene duración: arranca hoy
      v_nuevo_fin := v_now + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion_desde_hoy';
    END IF;

    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE COALESCE(v_anterior_saldo, 0) + COALESCE(v_tier.clases_incluidas, 0)
    END;

  ELSE
    -- Cambio de tipo → reset (créditos viejos se pierden, fechas se recalculan)
    v_modo := 'cambio_de_tipo';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;
  END IF;

  -- Delta neto para el ledger (puede ser negativo en cambio_de_tipo si pierde
  -- créditos previos, o cero en altas tipo=tiempo).
  v_delta_creditos := COALESCE(v_nuevo_saldo, 0) - COALESCE(v_anterior_saldo, 0);

  -- ── UPDATE o INSERT de la membresía ────────────────────────────────────
  IF v_existe_anterior THEN
    UPDATE membresias
    SET tier_id = p_tier_id,
        status = 'activa',
        periodo_actual_inicio = v_now,
        periodo_actual_fin = v_nuevo_fin,
        creditos_restantes = v_nuevo_saldo,
        updated_at = v_now
    WHERE id = v_anterior_id;
    v_membresia_id := v_anterior_id;
  ELSE
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin, creditos_restantes
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, 'activa',
      v_now, v_nuevo_fin, v_nuevo_saldo
    )
    RETURNING id INTO v_membresia_id;
  END IF;

  -- ── Ledger ─────────────────────────────────────────────────────────────
  -- Regla general: UN movimiento 'alta' con delta = neto (alta nueva,
  -- renovación, recarga — el delta nunca es negativo en estos casos).
  --
  -- Excepción: si es cambio_de_tipo Y había créditos previos que se pierden,
  -- escribimos DOS movimientos para preservar la semántica real:
  --   1) 'expiracion' delta = -saldo_anterior  (créditos perdidos)
  --   2) 'alta'       delta = nuevo_saldo      (créditos del nuevo paquete)
  -- Así 'alta' nunca queda con delta negativo y el historial cuenta lo que
  -- realmente pasó. Si el socio venía de tipo=tiempo (saldo 0/NULL), no hay
  -- nada que expirar — un solo movimiento 'alta'.
  v_motivo_final := COALESCE(
    NULLIF(trim(p_motivo), ''),
    format('%s — tier %s', v_modo, v_tier.slug)
  );

  IF v_modo = 'cambio_de_tipo' AND COALESCE(v_anterior_saldo, 0) > 0 THEN
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'expiracion', -v_anterior_saldo,
      NULL,
      format('créditos perdidos por cambio de plan (tier %s)', v_tier.slug),
      v_actor_id
    );

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', COALESCE(v_nuevo_saldo, 0),
      NULL, v_motivo_final, v_actor_id
    );
  ELSE
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', v_delta_creditos,
      NULL, v_motivo_final, v_actor_id
    );
  END IF;

  -- ── Sincronizar denormalized caches en usuarios ────────────────────────
  -- Si el socio venía en 'pendiente_pago' (caso típico: recién creado por
  -- admin-create-user), pasarlo a 'activo'. Otros status no se tocan.
  UPDATE usuarios
  SET membresia_tier = v_tier.slug,
      membresia_activa_id = v_membresia_id,
      status = CASE
        WHEN status = 'pendiente_pago' THEN 'activo'
        ELSE status
      END
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
    'success', true,
    'membresia_id', v_membresia_id,
    'modo', v_modo,
    'tier_slug', v_tier.slug,
    'tier_nombre', v_tier.nombre,
    'tier_tipo', v_tier.tipo,
    'periodo_actual_fin', v_nuevo_fin,
    'creditos_restantes', v_nuevo_saldo,
    'delta_creditos', v_delta_creditos
  );
END;
$$;

REVOKE ALL ON FUNCTION gestionar_membresia_socio(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gestionar_membresia_socio(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION gestionar_membresia_socio(uuid, uuid, text) IS
  'Fase 4 — alta/renovación manual de la membresía de un socio desde el admin. Solo staff del tenant del socio. Regla suma/reset: mismo tipo SUMA fechas/créditos (renovación o recarga); cambio de tipo RESETEA. Escribe ''alta'' en el ledger con delta neto y created_by=actor. Sincroniza usuarios.membresia_tier y membresia_activa_id (el gate aún los usa). Pasa status=pendiente_pago a activo (caso socio nuevo). Atómica con FOR UPDATE sobre la membresía vigente.';

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Fase 4 OK: gestionar_membresia_socio creada. Probá con scripts/test_gestionar_membresia.sql.';
END $$;
