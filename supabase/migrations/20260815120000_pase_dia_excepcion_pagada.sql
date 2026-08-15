-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- DAY PASS como EXCEPCIÓN PAGADA — dejar entrar un día que el plan NO cubre.
-- ────────────────────────────────────────────────────────────────────────────
-- Caso numa: un socio con plan Elevate (lun-vie) quiere venir un sábado. Hoy el
-- sistema no deja: el trigger `verificar_dia_acceso_reserva` bloquea el sábado, y
-- `recepcion_asignar_plan` no deja venderle un Day Pass porque ya tiene membresía
-- activa (MEMBRESIA_YA_EXISTE), y "cambiar plan" le borraría Elevate.
--
-- SOLUCIÓN (modelo elegido: excepción pagada, NO segunda membresía):
--   Recepción crea la reserva de ese día como una EXCEPCIÓN que (1) salta SOLO el
--   bloqueo de día y (2) cobra el precio del tier "pase" en la Caja como un pago
--   suelto (concepto='otro', sin membresia_id). El socio CONSERVA Elevate intacto;
--   no se crea ninguna membresía nueva. Después del sábado, todo sigue igual.
--
-- Nada hardcodeado: el precio sale del tier pase (es_pase = true) del propio gym.
-- La reserva se hace con `recepcion_crear_reserva` (misma validación de cupo,
-- lugar, membresía vigente, sede). Para planes 'tiempo' (Elevate/Ultra) no gasta
-- créditos. Es atómico: si la reserva falla, no hay cobro; y viceversa.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1) El trigger de día honra la bandera de excepción pagada ────────────────
CREATE OR REPLACE FUNCTION verificar_dia_acceso_reserva()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dias int[];
  v_tz text;
  v_dow int;
  v_nombre text;
BEGIN
  -- Excepción pagada (Day Pass): recepción cobró el día suelto vía
  -- recepcion_reservar_pase_dia → sin bloqueo de día para ESTA reserva.
  IF COALESCE(current_setting('sala.pase_dia', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  -- Días de acceso del plan ACTIVO del socio.
  SELECT t.dias_acceso INTO v_dias
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY m.created_at DESC
  LIMIT 1;

  -- Sin plan, o plan sin restricción → cualquier día.
  IF v_dias IS NULL OR cardinality(v_dias) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(config->>'timezone', 'America/Mexico_City') INTO v_tz
  FROM tenants WHERE id = NEW.tenant_id;

  v_dow := EXTRACT(DOW FROM (NEW.slot_inicio AT TIME ZONE v_tz))::int;

  IF NOT (v_dow = ANY(v_dias)) THEN
    v_nombre := CASE v_dow
      WHEN 0 THEN 'domingos' WHEN 1 THEN 'lunes'  WHEN 2 THEN 'martes'
      WHEN 3 THEN 'miércoles' WHEN 4 THEN 'jueves' WHEN 5 THEN 'viernes'
      WHEN 6 THEN 'sábados' END;
    RAISE EXCEPTION 'DIA_NO_PERMITIDO: Tu plan no incluye acceso los %', v_nombre;
  END IF;

  RETURN NEW;
END; $$;


-- ── 2) RPC: reservar cobrando un day pass (día fuera del plan) ───────────────
CREATE OR REPLACE FUNCTION recepcion_reservar_pase_dia(
  p_usuario_id uuid,
  p_metodo_pago text,
  p_pase_tier_id uuid DEFAULT NULL,
  p_clase_id uuid DEFAULT NULL,
  p_horario_id uuid DEFAULT NULL,
  p_fecha date DEFAULT NULL,
  p_lugar_id text DEFAULT NULL,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_tenant uuid;
  v_socio usuarios;
  v_pase tiers;
  v_result jsonb;
  v_reserva_id uuid;
  v_clase_id uuid;
  v_sucursal uuid;
  v_pago_id uuid;
BEGIN
  v_actor  := get_my_user_id();
  v_tenant := get_my_tenant_id();
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden vender un day pass';
  END IF;

  IF p_metodo_pago IS NULL OR p_metodo_pago NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Elegí cómo se cobró el day pass (efectivo, tarjeta o transferencia)';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id AND tenant_id = v_tenant;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;

  -- El pase a cobrar: el indicado, o el Day Pass del gym (es_pase, activo). El
  -- precio sale del tier — nunca hardcodeado.
  IF p_pase_tier_id IS NOT NULL THEN
    SELECT * INTO v_pase FROM tiers
    WHERE id = p_pase_tier_id AND tenant_id = v_tenant AND activo;
  ELSE
    SELECT * INTO v_pase FROM tiers
    WHERE tenant_id = v_tenant AND es_pase = true AND activo = true
    ORDER BY orden NULLS LAST, precio_centavos ASC
    LIMIT 1;
  END IF;

  IF v_pase.id IS NULL THEN
    RAISE EXCEPTION 'PASE_NO_CONFIGURADO: No hay un Day Pass configurado. Creá un plan con "es pase" activo para poder cobrarlo.';
  END IF;

  -- Crear la reserva saltando SOLO el bloqueo de día. El socio conserva su plan;
  -- recepcion_crear_reserva sigue validando cupo, lugar, membresía vigente y sede.
  PERFORM set_config('sala.pase_dia', 'on', true);
  v_result := recepcion_crear_reserva(
    p_usuario_id, p_clase_id, p_horario_id, p_fecha, 0, p_motivo, p_lugar_id,
    COALESCE(NULLIF(trim(p_motivo), ''), 'Day pass — día fuera de su plan')
  );
  PERFORM set_config('sala.pase_dia', 'off', true);

  v_reserva_id := (v_result->>'reserva_id')::uuid;
  v_clase_id   := (v_result->>'clase_id')::uuid;
  SELECT sucursal_id INTO v_sucursal FROM clases WHERE id = v_clase_id;

  -- Cobro suelto en Caja: NO crea membresía (el socio conserva su plan). El ledger
  -- de pagos es la fuente de la Caja; queda atado al socio, al pase y a la sede.
  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
    concepto, monto_centavos, moneda, metodo, notas, cobrado_por
  ) VALUES (
    v_tenant, v_sucursal, p_usuario_id, NULL, v_pase.id,
    'otro', v_pase.precio_centavos, COALESCE(v_pase.moneda, 'MXN'), p_metodo_pago,
    format('Day pass "%s" — reserva %s (día fuera de su plan)', v_pase.nombre, v_result->>'folio'),
    v_actor
  )
  RETURNING id INTO v_pago_id;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', v_result,
    'pago_id', v_pago_id,
    'pase', v_pase.nombre,
    'cobro_centavos', v_pase.precio_centavos,
    'moneda', COALESCE(v_pase.moneda, 'MXN')
  );
END;
$$;

REVOKE ALL ON FUNCTION recepcion_reservar_pase_dia(uuid, text, uuid, uuid, uuid, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_reservar_pase_dia(uuid, text, uuid, uuid, uuid, date, text, text) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA. Prueba el corazón del fix (la bandera del trigger):
--   1) plan lun-vie + sábado SIN bandera  → bloquea (DIA_NO_PERMITIDO).
--   2) mismo caso CON bandera 'sala.pase_dia' → deja pasar.
-- Crea datos de prueba y los revierte (no deja nada).
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_pase_dia()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_recurso uuid; v_tz text;
  v_sabado timestamptz;
  v_sin text := '(no corrió)';
  v_con text := '(no corrió)';
BEGIN
  -- Todo el montaje + las dos pruebas van en un sub-bloque que se REVIERTE al
  -- final (RAISE 'ROLLBACK_DIAG_PASE'). v_sin/v_con son variables → conservan su
  -- valor tras la excepción; los RETURN NEXT se hacen al final, ya sin excepción.
  BEGIN
    SELECT id INTO v_tenant FROM tenants WHERE status = 'activo' ORDER BY created_at LIMIT 1;
    SELECT id INTO v_recurso FROM recursos WHERE tenant_id = v_tenant LIMIT 1;
    v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id = v_tenant), 'America/Mexico_City');

    INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
    VALUES (v_tenant, 'pase-dia-test@example.com', 'Pase Día Test', 'miembro', 'activo')
    RETURNING id INTO v_socio;

    INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, dias_acceso, activo, orden)
    VALUES (v_tenant, 'pase-dia-test', 'Pase Día Test', 'tiempo', 100000, 'MXN', 30, ARRAY[1,2,3,4,5], true, 999)
    RETURNING id INTO v_tier;

    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
    VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days');

    -- Próximo sábado a mediodía en la tz del gym.
    v_sabado := ((date_trunc('week', (now() AT TIME ZONE v_tz)::date)::date + 5) + time '12:00') AT TIME ZONE v_tz;
    IF v_sabado <= now() THEN v_sabado := v_sabado + interval '7 days'; END IF;

    -- 1) SIN bandera → debe bloquear.
    BEGIN
      INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
      VALUES (v_tenant, v_recurso, v_socio, v_sabado, v_sabado + interval '1 hour', 60, 'TEST-PASE-1', 'confirmada');
      v_sin := '❌ dejó reservar sábado sin cobrar (inesperado)';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'DIA_NO_PERMITIDO%' THEN v_sin := '✅ bloquea sin bandera → ' || SQLERRM;
      ELSE v_sin := '⚠ otro error: ' || SQLERRM; END IF;
    END;

    -- 2) CON bandera → debe pasar.
    BEGIN
      PERFORM set_config('sala.pase_dia', 'on', true);
      INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
      VALUES (v_tenant, v_recurso, v_socio, v_sabado, v_sabado + interval '1 hour', 60, 'TEST-PASE-2', 'confirmada');
      PERFORM set_config('sala.pase_dia', 'off', true);
      v_con := '✅ con bandera SÍ deja reservar el sábado';
    EXCEPTION WHEN OTHERS THEN
      v_con := '❌ con bandera falló: ' || SQLERRM;
    END;

    RAISE EXCEPTION 'ROLLBACK_DIAG_PASE';  -- borra socio/tier/membresía/reservas de prueba
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_DIAG_PASE' THEN
      v_con := '❌ montaje falló: ' || SQLERRM;
    END IF;
  END;

  prueba := '1. sábado con plan lun-vie (sin cobro)'; resultado := v_sin; RETURN NEXT;
  prueba := '2. sábado con day pass (bandera)';        resultado := v_con; RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_pase_dia();
DROP FUNCTION _diag_pase_dia();
