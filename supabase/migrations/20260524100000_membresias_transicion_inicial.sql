-- ============================================================================
-- Membresías Prepago — Fase 2A.1: transición inicial al modelo de membresías
-- ============================================================================
-- Decisión: fuente de verdad única. Todos los socios actuales pasan a tener
-- una fila en `membresias`. Nadie queda "legacy" — el gate de la Fase 2A.2
-- (en reservar_clase_atomic) va a leer de membresias, no de usuarios.membresia_tier.
--
-- QUÉ HACE — para cada usuario con `usuarios.membresia_tier` seteado:
--   1. Resuelve el tier por (tenant_id, slug). Si no matchea ningún tier de
--      su tenant → es HUÉRFANO, lo reporta con NOTICE y NO lo migra.
--   2. Si el usuario YA tiene una membresía 'activa'/'trialing'/'past_due'/
--      'congelada' → lo saltea (idempotencia).
--   3. Si matchea y no tiene activa → crea una membresía con:
--        status='activa'
--        periodo_actual_inicio = now()
--        periodo_actual_fin    = now() + tier.duracion_dias días
--                                (NULL si el tier no tiene duración)
--        creditos_restantes    = NULL si tier.tipo='tiempo',
--                                tier.clases_incluidas en caso contrario
--      + inserta el movimiento 'alta' en membresia_movimientos
--      + setea usuarios.membresia_activa_id apuntando a la nueva membresía.
--   4. Defensivo: para los usuarios que ya tenían membresía activa pero
--      `usuarios.membresia_activa_id IS NULL`, hace UPDATE para apuntar el
--      FK al registro real. Sin esto, el gate de Fase 2A.2 podría no
--      encontrarlos vía el FK denormalizado. No inventa nada — solo conecta.
--
-- IDEMPOTENTE: re-correr no duplica. El `NOT EXISTS` filtra a quienes ya
-- tienen membresía activa, y el UPDATE de backfill es no-op si el FK ya
-- está seteado.
--
-- NO INVENTA NADA: huérfanos quedan reportados, no migrados. Inconsistencias
-- (usuario con membresia_tier='basica' pero membresía activa en tier 'pro')
-- también se respetan — la membresía activa existente es autoritativa.
-- ============================================================================

DO $$
DECLARE
  v_huerfanos integer := 0;
  v_creadas integer := 0;
  v_skipped integer := 0;
  v_backfilled integer := 0;
  v_now timestamptz := now();
  r record;
  v_new_id uuid;
  v_creditos integer;
  v_fin timestamptz;
BEGIN
  -- ── 1. Huérfanos: solo se reportan, no se migran ──
  FOR r IN
    SELECT u.id, u.email, u.tenant_id, u.membresia_tier
    FROM usuarios u
    WHERE u.membresia_tier IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tiers t
        WHERE t.tenant_id = u.tenant_id AND t.slug = u.membresia_tier
      )
  LOOP
    v_huerfanos := v_huerfanos + 1;
    RAISE NOTICE 'HUÉRFANO (NO migrado): usuario % <%> tenant=% tier_slug=% no matchea ningún tier',
      r.id, r.email, r.tenant_id, r.membresia_tier;
  END LOOP;

  -- ── 2. Crear membresía para los que matchean tier y no tienen activa ──
  FOR r IN
    SELECT
      u.id   AS usuario_id,
      u.email,
      u.tenant_id,
      t.id   AS tier_id,
      t.tipo AS tier_tipo,
      t.duracion_dias,
      t.clases_incluidas
    FROM usuarios u
    JOIN tiers t
      ON t.tenant_id = u.tenant_id
     AND t.slug = u.membresia_tier
    WHERE u.membresia_tier IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM membresias m
        WHERE m.usuario_id = u.id
          AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
      )
  LOOP
    -- Saldo inicial según tipo del tier
    v_creditos := CASE r.tier_tipo
                    WHEN 'tiempo' THEN NULL
                    ELSE r.clases_incluidas
                  END;

    -- Vencimiento: si el tier tiene duracion_dias, suma desde ahora; si no,
    -- NULL (créditos puros sin vencimiento — caso futuro).
    v_fin := CASE
               WHEN r.duracion_dias IS NULL THEN NULL
               ELSE v_now + (r.duracion_dias || ' days')::interval
             END;

    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin,
      creditos_restantes
    )
    VALUES (
      r.tenant_id, r.usuario_id, r.tier_id, 'activa',
      v_now, v_fin, v_creditos
    )
    RETURNING id INTO v_new_id;

    -- Movimiento de alta. Para tier=tiempo (sin saldo), delta=0 informativo.
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, motivo
    )
    VALUES (
      v_new_id, r.tenant_id, 'alta',
      COALESCE(v_creditos, 0),
      'migración inicial'
    );

    -- Apuntar el FK denormalizado del usuario a la nueva membresía
    UPDATE usuarios SET membresia_activa_id = v_new_id WHERE id = r.usuario_id;

    v_creadas := v_creadas + 1;
    RAISE NOTICE 'Migrada: <%> → membresía % (tier_id=%, vence=%, creditos=%)',
      r.email, v_new_id, r.tier_id, v_fin, v_creditos;
  END LOOP;

  -- ── 3. Backfill defensivo: usuarios con membresía activa pero
  --       membresia_activa_id IS NULL → apuntar el FK al registro real. ──
  WITH actualizados AS (
    UPDATE usuarios u
    SET membresia_activa_id = m.id
    FROM membresias m
    WHERE m.usuario_id = u.id
      AND m.status = 'activa'
      AND u.membresia_activa_id IS NULL
    RETURNING u.id
  )
  SELECT count(*) INTO v_backfilled FROM actualizados;

  -- ── 4. Conteo final de saltados (los que ya tenían activa) ──
  SELECT count(*) INTO v_skipped
  FROM usuarios u
  WHERE u.membresia_tier IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM tiers t
      WHERE t.tenant_id = u.tenant_id AND t.slug = u.membresia_tier
    )
    AND EXISTS (
      SELECT 1 FROM membresias m
      WHERE m.usuario_id = u.id
        AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
    );
  -- (este conteo cuenta ANTES de la migración; los recién creados quedan
  --  fuera porque al momento de empezar el bloque no tenían activa.)
  v_skipped := v_skipped - v_creadas;

  RAISE NOTICE '────────────────────────────────────────────────';
  RAISE NOTICE 'Transición de membresías OK:';
  RAISE NOTICE '  membresías creadas: %', v_creadas;
  RAISE NOTICE '  usuarios saltados (ya tenían activa): %', v_skipped;
  RAISE NOTICE '  FK membresia_activa_id backfilleados: %', v_backfilled;
  RAISE NOTICE '  huérfanos (NO migrados, ver detalle arriba): %', v_huerfanos;
END $$;
