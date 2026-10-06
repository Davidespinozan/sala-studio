-- ════════════════════════════════════════════════════════════════════════════
-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref `omrlbvhbggnrwwzlgxji`
-- DAY PASS: no descontar una clase del plan además de cobrar el pase
-- ────────────────────────────────────────────────────────────────────────────
-- Problema (numa, oct 2026): `recepcion_reservar_pase_dia` cobra el day pass a la
-- Caja y crea la reserva con `recepcion_crear_reserva`. Esa función DESCUENTA una
-- clase si el plan del socio es por clases/híbrido. Resultado con "Plan Motion
-- convenio" (híbrido, 15 clases, lun-vie): un sábado con day pass le cobraba $150
-- Y le quitaba 1 de sus 15 clases → cobro doble. Con planes por tiempo (Elevate,
-- Ultra, PROMO) no pasaba (no tienen créditos).
--
-- Fix: después de crear la reserva, si se le descontó clase, se la DEVUELVE en la
-- misma transacción con un movimiento 'devolucion' ligado a esa reserva. Así:
--   · su saldo queda igual que antes del day pass;
--   · el ledger cuadra (debito -1 / devolucion +1, misma reserva);
--   · si después se cancela la reserva, cancelar_reserva_atomic / _admin ven
--     débitos = devoluciones para esa reserva → NO devuelven otra vez (sin regalo).
--
-- Por qué NO se toca recepcion_crear_reserva: la migración en curso
-- 20261005260000_branch_isolation_hardening la redefine; redefinirla aquí haría
-- que una pisara a la otra según el orden en que se corran. Esta migración SOLO
-- redefine recepcion_reservar_pase_dia (que esa migración declara no tocar).
--
-- Cuerpo = 20260815120000 VERBATIM + el bloque "devolver la clase" (marcado).
-- Límite consciente: un socio híbrido con 0 clases sigue sin poder comprar day
-- pass por aquí (SIN_CREDITOS sale de recepcion_crear_reserva, antes del cobro).
-- BEGIN/COMMIT + self-test que DEVUELVE TABLA (aborta todo si algo falla).
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

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
  -- devolver la clase (planes por clases/híbridos)
  v_mem_id uuid;
  v_tier_tipo text;
  v_debitado integer;
  v_devuelto integer;
  v_monto integer := 0;
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

  -- ── NUEVO (20261006100000): devolver la clase ─────────────────────────────
  -- La clase de este día la paga el day pass, no el plan. Si recepcion_crear_reserva
  -- le descontó crédito (plan por clases/híbrido), se devuelve aquí mismo con un
  -- movimiento 'devolucion' de ESA reserva: el ledger queda débito = devolución y
  -- una cancelación posterior no vuelve a devolver.
  SELECT r.membresia_id, t.tipo INTO v_mem_id, v_tier_tipo
  FROM reservas r
  JOIN membresias m ON m.id = r.membresia_id
  JOIN tiers t ON t.id = m.tier_id
  WHERE r.id = v_reserva_id;

  IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos', 'hibrido') THEN
    SELECT COALESCE(-SUM(delta_creditos), 0) INTO v_debitado
    FROM membresia_movimientos
    WHERE membresia_id = v_mem_id AND reserva_id = v_reserva_id AND tipo = 'debito';
    SELECT COALESCE(SUM(delta_creditos), 0) INTO v_devuelto
    FROM membresia_movimientos
    WHERE membresia_id = v_mem_id AND reserva_id = v_reserva_id AND tipo = 'devolucion';
    v_monto := v_debitado - v_devuelto;

    IF v_monto > 0 THEN
      UPDATE membresias
      SET creditos_restantes = COALESCE(creditos_restantes, 0) + v_monto
      WHERE id = v_mem_id;

      INSERT INTO membresia_movimientos (
        membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
      ) VALUES (
        v_mem_id, v_tenant, 'devolucion', v_monto, v_reserva_id,
        format('Day pass: reserva %s pagada aparte, no gasta clase del plan', v_result->>'folio'),
        v_actor
      );
    END IF;
  END IF;
  -- ── fin NUEVO ─────────────────────────────────────────────────────────────

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
    'moneda', COALESCE(v_pase.moneda, 'MXN'),
    'creditos_devueltos', v_monto
  );
END;
$$;

REVOKE ALL ON FUNCTION recepcion_reservar_pase_dia(uuid, text, uuid, uuid, uuid, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recepcion_reservar_pase_dia(uuid, text, uuid, uuid, uuid, date, text, text) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST — DEVUELVE TABLA. Tenant desechable; si algo falla, ABORTA TODO.
--   1) plan híbrido lun-vie + sábado SIN day pass → DIA_NO_PERMITIDO (regresión).
--   2) day pass a socio híbrido → cobra a la Caja y su saldo NO baja.
--   3) cancelar esa reserva → NO le regala una clase extra.
--   4) day pass a socio de plan por tiempo → cobra, sin movimientos de crédito.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_pase_dia_no_descuenta()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_slug text := 'zz-pdnd-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_admin uuid;
  v_suc uuid; v_sala uuid; v_clase uuid;
  v_tier_h uuid; v_tier_t uuid; v_pase uuid;
  v_sh uuid; v_st uuid; v_mem_h uuid; v_mem_t uuid;
  v_sab date; v_res jsonb; v_reserva uuid;
  v_ok boolean; v_cred integer; v_n integer; v_pago integer;
  v_fallas integer := 0;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'PDND','gym_libre','activo') RETURNING id INTO v_tenant;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',v_slug||'-a@sala.dev',
          jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),'',now(),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth RETURNING id INTO v_admin;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SETUP: no se creó la ficha admin'; END IF;

  INSERT INTO sucursales (tenant_id,nombre,timezone,activa,orden) VALUES (v_tenant,'Sede','America/Mexico_City',true,0) RETURNING id INTO v_suc;
  INSERT INTO recursos (tenant_id,sucursal_id,slug,nombre,tipo,cupos,cupo_max_default,activo)
  VALUES (v_tenant,v_suc,'sala-1','Sala 1','sala_grupal',10,10,true) RETURNING id INTO v_sala;

  -- Planes: híbrido lun-vie (5 clases), tiempo lun-vie, y el Day Pass (es_pase).
  INSERT INTO tiers (tenant_id,slug,nombre,tipo,precio_centavos,moneda,activo,orden,duracion_dias,clases_incluidas,dias_acceso)
  VALUES (v_tenant,'hib','Híbrido','hibrido',100000,'MXN',true,0,30,5,ARRAY[1,2,3,4,5]) RETURNING id INTO v_tier_h;
  INSERT INTO tiers (tenant_id,slug,nombre,tipo,precio_centavos,moneda,activo,orden,duracion_dias,dias_acceso)
  VALUES (v_tenant,'tiempo','Tiempo','tiempo',100000,'MXN',true,1,30,ARRAY[1,2,3,4,5]) RETURNING id INTO v_tier_t;
  INSERT INTO tiers (tenant_id,slug,nombre,tipo,precio_centavos,moneda,activo,orden,duracion_dias,clases_incluidas,es_pase)
  VALUES (v_tenant,'daypass','Day Pass','hibrido',15000,'MXN',true,2,7,1,true) RETURNING id INTO v_pase;

  -- Próximo sábado (siempre futuro), clase a las 10:00.
  v_sab := current_date + ((6 - EXTRACT(DOW FROM current_date)::int + 7) % 7);
  IF v_sab <= current_date THEN v_sab := v_sab + 7; END IF;
  INSERT INTO clases (tenant_id,sucursal_id,recurso_id,fecha,hora_inicio,duracion_minutos,cupo_max,status,nombre)
  VALUES (v_tenant,v_suc,v_sala,v_sab,'10:00',60,10,'programada','Clase sábado') RETURNING id INTO v_clase;

  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-h@x.dev','Socio híbrido','miembro','activo') RETURNING id INTO v_sh;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-t@x.dev','Socio tiempo','miembro','activo') RETURNING id INTO v_st;
  INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,creditos_restantes)
  VALUES (v_tenant,v_sh,v_tier_h,'activa',now()-interval '1 day',now()+interval '30 days',5) RETURNING id INTO v_mem_h;
  INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin)
  VALUES (v_tenant,v_st,v_tier_t,'activa',now()-interval '1 day',now()+interval '30 days') RETURNING id INTO v_mem_t;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- 1) Sin day pass, el sábado se sigue bloqueando.
  v_ok := false;
  BEGIN
    PERFORM recepcion_crear_reserva(v_sh, v_clase, NULL, NULL, 0, 'test', NULL, 'test');
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'DIA_NO_PERMITIDO%';
  END;
  prueba := '1. híbrido lun-vie, sábado sin day pass → DIA_NO_PERMITIDO';
  resultado := CASE WHEN v_ok THEN '✅ bloquea' ELSE '❌ no bloqueó' END;
  IF NOT v_ok THEN v_fallas := v_fallas + 1; END IF;
  RETURN NEXT;

  -- 2) Day pass a socio híbrido: cobra $150 y su saldo sigue en 5.
  v_res := recepcion_reservar_pase_dia(v_sh, 'efectivo', v_pase, v_clase, NULL, NULL, NULL, NULL);
  v_reserva := (v_res->'reserva'->>'reserva_id')::uuid;
  SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem_h;
  SELECT COALESCE(SUM(monto_centavos),0) INTO v_pago FROM pagos WHERE usuario_id = v_sh AND concepto = 'otro';
  v_ok := v_cred = 5 AND v_pago = 15000;
  prueba := '2. day pass a híbrido → cobra $150 y NO descuenta clase';
  resultado := CASE WHEN v_ok THEN '✅ saldo 5, cobro 15000'
                    ELSE format('❌ saldo %s, cobro %s', v_cred, v_pago) END;
  IF NOT v_ok THEN v_fallas := v_fallas + 1; END IF;
  RETURN NEXT;

  -- 3) Cancelar esa reserva no regala una clase (débito = devolución ya).
  PERFORM cancelar_reserva_admin(v_reserva, 'test', false);
  SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem_h;
  v_ok := v_cred = 5;
  prueba := '3. cancelar la reserva del day pass → saldo sigue en 5 (sin regalo)';
  resultado := CASE WHEN v_ok THEN '✅ saldo 5' ELSE format('❌ saldo %s', v_cred) END;
  IF NOT v_ok THEN v_fallas := v_fallas + 1; END IF;
  RETURN NEXT;

  -- 4) Socio de plan por tiempo: cobra, sin movimientos de crédito.
  v_res := recepcion_reservar_pase_dia(v_st, 'tarjeta', v_pase, v_clase, NULL, NULL, NULL, NULL);
  SELECT count(*) INTO v_n FROM membresia_movimientos WHERE membresia_id = v_mem_t;
  SELECT COALESCE(SUM(monto_centavos),0) INTO v_pago FROM pagos WHERE usuario_id = v_st AND concepto = 'otro';
  v_ok := v_n = 0 AND v_pago = 15000 AND (v_res->>'creditos_devueltos')::int = 0;
  prueba := '4. day pass a plan por tiempo → cobra $150, sin movimientos de crédito';
  resultado := CASE WHEN v_ok THEN '✅ sin movimientos, cobro 15000'
                    ELSE format('❌ movimientos %s, cobro %s', v_n, v_pago) END;
  IF NOT v_ok THEN v_fallas := v_fallas + 1; END IF;
  RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);

  IF v_fallas > 0 THEN
    RAISE EXCEPTION 'SELF-TEST FALLÓ (% prueba(s)) — se revierte toda la migración', v_fallas;
  END IF;
  RETURN;
END $$;

SELECT * FROM _diag_pase_dia_no_descuenta();
DROP FUNCTION _diag_pase_dia_no_descuenta();

COMMIT;
