-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- CHECK-IN: la RESERVA manda (no bloquear por vigencia una clase ya reservada)
-- ----------------------------------------------------------------------------
-- REGLA DE NEGOCIO (definida con el dueño, ago 2026):
--   · La vigencia del plan (duracion_dias) limita hasta cuándo se puede RESERVAR
--     y consumir créditos. Los créditos NO usados caducan con la vigencia.
--   · PERO una RESERVA ya hecha se respeta al hacer check-in, aunque la clase caiga
--     después de la vigencia. El crédito ya se "gastó" al reservar; la reserva es la
--     prueba del derecho a entrar.
--   Ejemplo real: day pass con vigencia de 7 días, el socio reserva para el día 10.
--   Esa clase SE DEBE poder tomar. Hoy el check-in lo bloqueaba → esto lo corrige.
--
-- EL PROBLEMA: 20260717100000 agregó un candado que bloquea el check-in automático
-- (QR y huella) si la membresía no está "viva" (vencida / expirada→sin_membresia /
-- congelada). Ese candado no mira si YA hay una reserva, así que rompía la regla:
-- una reserva válida para una fecha fuera de la vigencia no dejaba entrar.
--
-- LA CORRECCIÓN: el check-in SIEMPRE es contra una reserva confirmada (check_in_atomic
-- recibe la reserva; check_in_por_huella la busca). Como esa reserva ya validó el
-- derecho al reservarse, el check-in NO debe volver a juzgar la membresía. El guard
-- pasa a NO bloquear; el estado sigue viajando en la respuesta para que la pantalla
-- lo muestre (info), pero no impide entrar. Es la misma filosofía que ya tenía la
-- vía MANUAL ("recepción ve y decide"), ahora también para las automáticas.
--
-- NO se toca el gate de RESERVAR (reservar_clase_atomic): ahí la vigencia y los
-- créditos siguen mandando. Solo cambia el CHECK-IN.
-- ============================================================================


-- ── 1) El estado, ahora reconoce 'expirada' → reporta 'vencida' (no 'sin_membresia')
-- Antes la consulta omitía 'expirada', así que una membresía barrida por el cron de
-- expiración se reportaba como 'sin_membresia' (impreciso). La incluimos para que la
-- pantalla muestre "vencida" de verdad. (Ya no bloquea; es solo el texto informativo.)
CREATE OR REPLACE FUNCTION _estado_membresia_checkin(p_usuario_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol text;
  v_status text;
  v_fin timestamptz;
BEGIN
  SELECT rol INTO v_rol FROM usuarios WHERE id = p_usuario_id;

  -- Solo los socios tienen membresía que pueda estar muerta.
  IF v_rol IS DISTINCT FROM 'miembro' THEN
    RETURN 'ok';
  END IF;

  SELECT m.status, m.periodo_actual_fin
  INTO v_status, v_fin
  FROM membresias m
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada', 'expirada')
  ORDER BY
    CASE m.status
      WHEN 'activa'    THEN 0
      WHEN 'trialing'  THEN 1
      WHEN 'past_due'  THEN 2
      WHEN 'congelada' THEN 3
      WHEN 'expirada'  THEN 4
    END,
    m.created_at DESC
  LIMIT 1;

  IF v_status IS NULL THEN
    RETURN 'sin_membresia';
  END IF;

  IF v_status = 'congelada' THEN
    RETURN 'congelada';
  END IF;

  IF v_status = 'expirada' THEN
    RETURN 'vencida';
  END IF;

  IF v_fin IS NOT NULL AND v_fin <= now() THEN
    RETURN 'vencida';
  END IF;

  RETURN 'ok';
END;
$$;


-- ── 2) El guard ya NO bloquea: la reserva manda ─────────────────────────────
-- Se mantiene la función (y las vías automáticas la siguen LLAMANDO, así el test de
-- contrato de 20260717100000 sigue pasando), pero su cuerpo ya no rechaza: el
-- check-in honra la reserva confirmada sin importar el estado de la membresía.
CREATE OR REPLACE FUNCTION _guard_membresia_checkin(p_usuario_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- La RESERVA manda. El check-in siempre es contra una reserva confirmada, que ya
  -- gastó el crédito al hacerse. La vigencia limita cuándo se RESERVA, no cuándo se
  -- asiste a una clase ya reservada (ej.: day pass de 7 días, reserva para el día 10).
  -- Por eso NO se bloquea por estado de membresía. El estado viaja en la respuesta
  -- (_estado_membresia_checkin) para que la pantalla lo muestre, pero no impide entrar.
  RETURN;
END;
$$;


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA. Con una membresía VENCIDA (expirada) + reserva:
--   1) el guard ya NO bloquea el check-in.
--   2) el estado se reporta como 'vencida' (para el aviso en pantalla).
-- Todo en un sub-bloque que se revierte.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_checkin_honra_reserva()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid;
  v_guard text := '(no corrió)';
  v_estado text := '(no corrió)';
BEGIN
  BEGIN
    SELECT id INTO v_tenant FROM tenants WHERE status = 'activo' ORDER BY created_at LIMIT 1;

    INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
    VALUES (v_tenant, 'checkin-honra-test@example.com', 'Checkin Honra Test', 'miembro', 'activo')
    RETURNING id INTO v_socio;

    INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, clases_incluidas, activo, orden)
    VALUES (v_tenant, 'checkin-honra-test', 'Checkin Honra Test', 'creditos', 10000, 'MXN', 7, 5, true, 999)
    RETURNING id INTO v_tier;

    -- Membresía VENCIDA (barrida por el cron: status 'expirada', periodo ya pasó)
    -- con un crédito sin usar (el que quedó amarrado a una reserva a futuro).
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status,
                            periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_socio, v_tier, 'expirada',
            now() - interval '10 days', now() - interval '3 days', 1);

    -- 1) El guard ya no debe reventar.
    BEGIN
      PERFORM _guard_membresia_checkin(v_socio);
      v_guard := '✅ deja entrar (la reserva manda)';
    EXCEPTION WHEN OTHERS THEN
      v_guard := '❌ todavía bloquea: ' || SQLERRM;
    END;

    -- 2) El estado informativo debe ser 'vencida'.
    v_estado := _estado_membresia_checkin(v_socio);

    RAISE EXCEPTION 'ROLLBACK_CHR';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_CHR' THEN
      v_guard := '❌ montaje falló: ' || SQLERRM;
    END IF;
  END;

  prueba := '1. check-in con membresía vencida + reserva → deja entrar';
  resultado := v_guard; RETURN NEXT;
  prueba := '2. estado informativo de una expirada';
  resultado := CASE WHEN v_estado = 'vencida' THEN '✅ vencida' ELSE '⚠ devolvió: ' || v_estado END;
  RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_checkin_honra_reserva();
DROP FUNCTION _diag_checkin_honra_reserva();
