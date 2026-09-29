-- ============================================================================
-- WAVE 4-A — Ledger / Credit Integrity (autoridad + protección de historia)
-- ============================================================================
-- Diseño congelado y aprobado por el owner (2026-09-29). Opción B:
--   · membresias.creditos_restantes = autoridad OPERACIONAL del saldo.
--   · membresia_movimientos = evidencia económica OBLIGATORIA, inmutable y
--     durable, desde esta frontera hacia adelante. NO se reconstruye historia
--     previa (las 31 divergencias históricas NO se tocan).
--
-- Esta pieza (W4-A) instala los guardrails y el helper canónico. NO enruta
-- todavía los RPCs por el helper (eso es W4-B) NI enciende el bloqueo del
-- UPDATE directo de creditos_restantes (eso es A5, la migración FINAL). Por eso
-- W4-A es 100% aditiva y no cambia el comportamiento de ninguna ruta actual.
--
-- Contenido:
--   1) Helper canónico _aplicar_credito (única puerta futura del saldo).
--   2) Protección DELETE del ledger (BEFORE DELETE trigger).
--   3) FK spine membresia_id/tenant_id: CASCADE -> RESTRICT.
--   4) cerrar_tenant: adaptado para purgar el ledger explícitamente (bajo flag).
--   5) reset_sala_demo: adaptado para purgar bajo flag.
--   6) Self-tests que DEVUELVEN TABLA + contract test W1/W2/W3.
--
-- NO toca: RPCs de crédito (W4-B), huella (check_in_*/_audrec_log), W1/W2/W3,
-- ni datos reales. Todo en BEGIN/COMMIT: si un self-test falla, revierte entero.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1) HELPER CANÓNICO  _aplicar_credito
-- ----------------------------------------------------------------------------
-- Única puerta (a futuro) para cambiar el saldo: bloquea la membresía, veta
-- saldo negativo, escribe caché + asiento en una sola operación atómica, y
-- prende la bandera transaccional 'sala.credito_canonico' alrededor del UPDATE.
-- Esa bandera será leída por el trigger de A5 (aún NO instalado); mientras A5
-- no exista, el set_config es inocuo. Así "saldo cambió <=> hay asiento" queda
-- garantizado por construcción cuando W4-B enrute los RPCs por acá.
--
-- CONTRATO: se invoca SOLO para membresías con tier de crédito (creditos/
-- hibrido), igual que todos los callers actuales que ya gatean por tier tipo.
-- No hace lookup de tier a propósito (evita acoplar el helper al modelo de tier).
-- ============================================================================
CREATE OR REPLACE FUNCTION _aplicar_credito(
  p_membresia_id   uuid,
  p_delta          integer,
  p_tipo           text,
  p_motivo         text,
  p_reserva_id     uuid DEFAULT NULL,
  p_lista_espera_id uuid DEFAULT NULL,
  p_actor          uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant   uuid;
  v_actual   integer;
  v_nuevo    integer;
BEGIN
  IF p_tipo NOT IN ('alta','debito','devolucion','expiracion','ajuste','no_show') THEN
    RAISE EXCEPTION 'CREDITO_TIPO_INVALIDO: tipo "%" no es un movimiento de ledger válido', p_tipo;
  END IF;

  -- Serializa contra otras mutaciones del mismo saldo (reusa el patrón de W2).
  SELECT tenant_id, creditos_restantes
    INTO v_tenant, v_actual
  FROM membresias
  WHERE id = p_membresia_id
  FOR UPDATE;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: no hay membresía % para aplicar crédito', p_membresia_id;
  END IF;

  v_nuevo := COALESCE(v_actual, 0) + p_delta;

  -- D2: nunca saldo negativo (backstop; los callers ya pre-chequean SIN_CREDITOS).
  IF v_nuevo < 0 THEN
    RAISE EXCEPTION 'SALDO_NEGATIVO: la operación dejaría el saldo en % (no permitido)', v_nuevo;
  END IF;

  -- Ventana mínima con la bandera canónica alrededor del ÚNICO UPDATE del saldo.
  PERFORM set_config('sala.credito_canonico', 'on', true);
  UPDATE membresias
     SET creditos_restantes = v_nuevo
   WHERE id = p_membresia_id;
  PERFORM set_config('sala.credito_canonico', 'off', true);

  -- Asiento obligatorio (mismo tx) — evidencia económica durable.
  INSERT INTO membresia_movimientos
    (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, lista_espera_id, motivo, created_by)
  VALUES
    (p_membresia_id, v_tenant, p_tipo, p_delta, p_reserva_id, p_lista_espera_id, p_motivo, p_actor);

  RETURN v_nuevo;
END;
$$;

REVOKE ALL ON FUNCTION _aplicar_credito(uuid, integer, text, text, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION _aplicar_credito(uuid, integer, text, text, uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION _aplicar_credito(uuid, integer, text, text, uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION _aplicar_credito(uuid, integer, text, text, uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION _aplicar_credito(uuid, integer, text, text, uuid, uuid, uuid) IS
  'W4-A. Puerta canónica del saldo: FOR UPDATE + veto de saldo negativo + UPDATE '
  'de creditos_restantes (bajo bandera sala.credito_canonico) + asiento en '
  'membresia_movimientos, atómico. Se invoca solo para tiers de crédito. W4-B '
  'enruta los RPCs por acá; A5 instalará el trigger que exige la bandera.';


-- ============================================================================
-- 2) PROTECCIÓN DELETE DEL LEDGER  (D4)
-- ----------------------------------------------------------------------------
-- El ledger ya bloquea UPDATE (trg_membresia_mov_no_update). Faltaba DELETE:
-- hoy un cascade (borrar membresía/tenant/usuario) o un DELETE directo lo
-- destruye en silencio. Se bloquea el DELETE salvo dentro de las rutas
-- destructivas SANCIONADAS, que prenden una bandera transaccional:
--   · sala.cierre_tenant   (cerrar_tenant, ya existía)
--   · sala.ledger_purga_ok (reset del demo, nuevo)
-- ============================================================================
CREATE OR REPLACE FUNCTION trg_membresia_mov_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('sala.ledger_purga_ok', true) = 'on'
     OR current_setting('sala.cierre_tenant', true) = 'on' THEN
    RETURN OLD;  -- purga sancionada (cierre de tenant / reset del demo)
  END IF;
  RAISE EXCEPTION 'LEDGER_INMUTABLE: membresia_movimientos es evidencia económica; no se borra (la historia sobrevive a la baja del socio)';
END;
$$;

DROP TRIGGER IF EXISTS membresia_mov_no_delete ON membresia_movimientos;
CREATE TRIGGER membresia_mov_no_delete
  BEFORE DELETE ON membresia_movimientos
  FOR EACH ROW
  EXECUTE FUNCTION trg_membresia_mov_no_delete();


-- ============================================================================
-- 3) FK SPINE  membresia_id / tenant_id :  CASCADE -> RESTRICT  (D4)
-- ----------------------------------------------------------------------------
-- Con RESTRICT, borrar una membresía/tenant que tenga historia económica
-- FALLA a nivel constraint (segunda línea de defensa, complementa el trigger).
-- Las rutas sancionadas (cerrar_tenant / reset demo) borran el ledger PRIMERO,
-- así el RESTRICT ya no aplica. DROP robusto por conkey (no por nombre).
-- ============================================================================
DO $$
DECLARE
  v_attnum smallint;
  v_name   text;
BEGIN
  -- ── membresia_id ──
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'membresia_movimientos'::regclass
    AND attname = 'membresia_id' AND NOT attisdropped;

  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'membresia_movimientos'::regclass
    AND contype = 'f' AND conkey = ARRAY[v_attnum]::int2[]
  LIMIT 1;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE membresia_movimientos DROP CONSTRAINT %I', v_name);
  END IF;
  ALTER TABLE membresia_movimientos
    ADD CONSTRAINT membresia_movimientos_membresia_id_fkey
    FOREIGN KEY (membresia_id) REFERENCES membresias(id) ON DELETE RESTRICT;

  -- ── tenant_id ──
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'membresia_movimientos'::regclass
    AND attname = 'tenant_id' AND NOT attisdropped;

  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'membresia_movimientos'::regclass
    AND contype = 'f' AND conkey = ARRAY[v_attnum]::int2[]
  LIMIT 1;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE membresia_movimientos DROP CONSTRAINT %I', v_name);
  END IF;
  ALTER TABLE membresia_movimientos
    ADD CONSTRAINT membresia_movimientos_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
END $$;

COMMENT ON TABLE membresia_movimientos IS
  'Ledger append-only e inmutable de movimientos de crédito por membresía. '
  'UPDATE y DELETE bloqueados por trigger; FK membresia_id/tenant_id = RESTRICT '
  '(la historia económica sobrevive a la baja del socio). Purga solo dentro de '
  'cerrar_tenant / reset del demo, bajo bandera transaccional. reserva_id y '
  'created_by son uuids sueltos sin FK por inmutabilidad.';


-- ============================================================================
-- 4) cerrar_tenant — adaptado: purga el ledger EXPLÍCITAMENTE antes de usuarios
-- ----------------------------------------------------------------------------
-- Con el nuevo RESTRICT, el "DELETE FROM usuarios" ya no puede cascadear a
-- membresias -> membresia_movimientos. Se borra el ledger primero (la bandera
-- sala.cierre_tenant que esta función ya prende autoriza el DELETE trigger).
-- Único cambio vs la versión previa: el DELETE de membresia_movimientos + su
-- conteo en el retorno. El resto es verbatim.
-- ============================================================================
CREATE OR REPLACE FUNCTION cerrar_tenant(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_auth_ids uuid[];
  v_usuarios integer;
  v_reservas integer;
  v_pagos integer;
  v_movimientos integer;
  v_auth integer;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = p_slug;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_NO_EXISTE: No hay ningún gym con el slug "%"', p_slug;
  END IF;

  -- Guardar las cuentas auth ANTES de borrar usuarios (si no, quedan huérfanas).
  SELECT COALESCE(array_agg(auth_id), ARRAY[]::uuid[])
  INTO v_auth_ids
  FROM usuarios
  WHERE tenant_id = v_tenant_id AND auth_id IS NOT NULL;

  -- El flag vive solo en ESTA transacción (tercer parámetro = is_local).
  PERFORM set_config('sala.cierre_tenant', 'on', true);

  DELETE FROM pagos    WHERE tenant_id = v_tenant_id;
  GET DIAGNOSTICS v_pagos = ROW_COUNT;

  DELETE FROM reservas WHERE tenant_id = v_tenant_id;
  GET DIAGNOSTICS v_reservas = ROW_COUNT;

  -- W4-A: el ledger ahora es RESTRICT; se borra explícitamente ANTES de usuarios
  -- (la bandera sala.cierre_tenant autoriza el trigger BEFORE DELETE del ledger).
  DELETE FROM membresia_movimientos WHERE tenant_id = v_tenant_id;
  GET DIAGNOSTICS v_movimientos = ROW_COUNT;

  -- Ahora sí: ya nada RESTRICT-ea a los usuarios ni a sus membresías.
  DELETE FROM usuarios WHERE tenant_id = v_tenant_id;
  GET DIAGNOSTICS v_usuarios = ROW_COUNT;

  -- Y el tenant se lleva en cascada todo lo demás.
  DELETE FROM tenants WHERE id = v_tenant_id;

  -- Las cuentas de login.
  DELETE FROM auth.users WHERE id = ANY(v_auth_ids);
  GET DIAGNOSTICS v_auth = ROW_COUNT;

  PERFORM set_config('sala.cierre_tenant', 'off', true);

  RETURN jsonb_build_object(
    'success', true,
    'slug', p_slug,
    'usuarios_borrados', v_usuarios,
    'reservas_borradas', v_reservas,
    'pagos_borrados', v_pagos,
    'movimientos_borrados', v_movimientos,
    'cuentas_auth_borradas', v_auth
  );
END;
$$;

REVOKE ALL ON FUNCTION cerrar_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cerrar_tenant(text) FROM anon;
REVOKE ALL ON FUNCTION cerrar_tenant(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION cerrar_tenant(text) TO service_role;

COMMENT ON FUNCTION cerrar_tenant(text) IS
  'Baja definitiva de un gym: borra pagos, reservas, ledger, usuarios, el tenant '
  '(cascade) y las cuentas de auth. Irreversible. Solo service_role.';


-- ============================================================================
-- 5) reset_sala_demo — adaptado: purga bajo bandera sala.ledger_purga_ok
-- ----------------------------------------------------------------------------
-- Único cambio vs la versión previa (20260616130000): prende/apaga la bandera
-- para que su DELETE de membresia_movimientos pase el nuevo trigger. El resto
-- es verbatim. Solo toca el tenant demo 'healthyspace'.
-- ============================================================================
CREATE OR REPLACE FUNCTION reset_sala_demo()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_demo uuid;
  v_corte timestamptz := now() - interval '25 hours';
BEGIN
  SELECT id INTO v_demo FROM tenants WHERE slug = 'healthyspace';
  IF v_demo IS NULL THEN
    RETURN;
  END IF;

  -- W4-A: autoriza el DELETE del ledger (demo, purga sancionada).
  PERFORM set_config('sala.ledger_purga_ok', 'on', true);

  DELETE FROM notificaciones        WHERE tenant_id = v_demo AND creada_at  > v_corte;
  DELETE FROM lista_espera          WHERE tenant_id = v_demo AND created_at > v_corte;
  DELETE FROM membresia_movimientos WHERE tenant_id = v_demo AND created_at > v_corte;
  DELETE FROM reservas              WHERE tenant_id = v_demo AND created_at > v_corte;
  DELETE FROM membresias            WHERE tenant_id = v_demo AND created_at > v_corte;

  DELETE FROM usuarios u
  WHERE u.tenant_id = v_demo
    AND u.created_at > v_corte
    AND (u.rol = 'miembro'
         OR u.auth_id IN (SELECT id FROM auth.users WHERE is_anonymous = true));

  PERFORM set_config('sala.ledger_purga_ok', 'off', true);
END;
$$;

COMMENT ON FUNCTION reset_sala_demo() IS
  'Limpia visitantes anónimos del demo y su actividad transaccional (healthyspace, '
  'últimas 25h). Purga el ledger del demo bajo bandera sala.ledger_purga_ok. '
  'Programada de noche vía pg_cron.';


-- ============================================================================
-- 6) SELF-TESTS (DEVUELVEN TABLA) + CONTRACT TEST W1/W2/W3
-- ----------------------------------------------------------------------------
-- Todo sobre un tenant desechable 'zz-w4a-*' que cerrar_tenant limpia al final.
-- Si algo falla, el DO block RAISE -> BEGIN/COMMIT revierte TODO (prod intacta).
-- ============================================================================
CREATE TEMP TABLE _w4a_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $$
DECLARE
  v_slug text := 'zz-w4a-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid;
  v_usuario uuid;
  v_tier uuid;
  v_mem uuid;
  v_mov uuid;
  v_saldo integer;
  v_ok boolean;
  v_cnt integer;
  v_ret jsonb;
BEGIN
  -- ── Setup ──
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'W4A test', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '@sala.dev', 'W4A', 'miembro', 'activo') RETURNING id INTO v_usuario;

  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas)
  VALUES (v_tenant, 'w4a-cred', 'W4A Créditos', 100000, 'creditos', 10) RETURNING id INTO v_tier;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, creditos_restantes)
  VALUES (v_tenant, v_usuario, v_tier, 'activa', 0) RETURNING id INTO v_mem;

  -- ── T1: _aplicar_credito aplica saldo + asiento atómico ──
  v_saldo := _aplicar_credito(v_mem, 5, 'alta', 'test alta', NULL, NULL, v_usuario);
  SELECT creditos_restantes INTO v_cnt FROM membresias WHERE id = v_mem;
  v_saldo := _aplicar_credito(v_mem, -2, 'debito', 'test debito', NULL, NULL, v_usuario);
  IF v_saldo <> 3 THEN RAISE EXCEPTION 'T1 FALLO: saldo esperado 3, got %', v_saldo; END IF;
  SELECT creditos_restantes INTO v_cnt FROM membresias WHERE id = v_mem;
  IF v_cnt <> 3 THEN RAISE EXCEPTION 'T1 FALLO: caché esperado 3, got %', v_cnt; END IF;
  SELECT COALESCE(SUM(delta_creditos),0) INTO v_cnt FROM membresia_movimientos WHERE membresia_id = v_mem;
  IF v_cnt <> 3 THEN RAISE EXCEPTION 'T1 FALLO: SUM(ledger) esperado 3, got %', v_cnt; END IF;
  INSERT INTO _w4a_res VALUES (1, '_aplicar_credito: caché y ledger cuadran (5 alta, -2 debito => 3)', 'OK');

  -- ── T2: veto de saldo negativo ──
  v_ok := false;
  BEGIN
    PERFORM _aplicar_credito(v_mem, -99, 'debito', 'sobregiro', NULL, NULL, v_usuario);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SALDO_NEGATIVO%' THEN v_ok := true; END IF;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T2 FALLO: se permitió saldo negativo'; END IF;
  INSERT INTO _w4a_res VALUES (2, 'veto de SALDO_NEGATIVO', 'OK');

  -- ── T3: DELETE directo del ledger bloqueado ──
  SELECT id INTO v_mov FROM membresia_movimientos WHERE membresia_id = v_mem LIMIT 1;
  v_ok := false;
  BEGIN
    DELETE FROM membresia_movimientos WHERE id = v_mov;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'LEDGER_INMUTABLE%' THEN v_ok := true; END IF;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T3 FALLO: se pudo borrar un asiento del ledger'; END IF;
  INSERT INTO _w4a_res VALUES (3, 'DELETE directo del ledger bloqueado (LEDGER_INMUTABLE)', 'OK');

  -- ── T4: borrar membresía con historia bloqueado por RESTRICT ──
  v_ok := false;
  BEGIN
    DELETE FROM membresias WHERE id = v_mem;
  EXCEPTION WHEN OTHERS THEN
    v_ok := true;  -- FK RESTRICT (foreign_key_violation) o el trigger
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T4 FALLO: se pudo borrar una membresía con ledger'; END IF;
  IF NOT EXISTS (SELECT 1 FROM membresias WHERE id = v_mem) THEN
    RAISE EXCEPTION 'T4 FALLO: la membresía desapareció pese al RESTRICT';
  END IF;
  INSERT INTO _w4a_res VALUES (4, 'borrar membresía con ledger bloqueado (FK RESTRICT)', 'OK');

  -- ── T5: DELETE bajo bandera sancionada permitido ──
  v_ok := true;
  BEGIN
    PERFORM set_config('sala.ledger_purga_ok', 'on', true);
    DELETE FROM membresia_movimientos WHERE id = v_mov;
    PERFORM set_config('sala.ledger_purga_ok', 'off', true);
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T5 FALLO: la purga sancionada del ledger no funcionó'; END IF;
  INSERT INTO _w4a_res VALUES (5, 'DELETE bajo bandera sala.ledger_purga_ok permitido', 'OK');

  -- ── T6: cerrar_tenant se lleva todo (incl. ledger) y lo reporta ──
  v_ret := cerrar_tenant(v_slug);
  IF EXISTS (SELECT 1 FROM tenants WHERE id = v_tenant) THEN
    RAISE EXCEPTION 'T6 FALLO: el tenant sobrevivió al cierre';
  END IF;
  IF EXISTS (SELECT 1 FROM membresia_movimientos WHERE tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'T6 FALLO: quedaron movimientos tras el cierre';
  END IF;
  INSERT INTO _w4a_res VALUES (6,
    'cerrar_tenant compat: purgó ledger + tenant (movimientos_borrados=' ||
    COALESCE((v_ret->>'movimientos_borrados'),'?') || ')', 'OK');
END $$;

-- ── CONTRACT TEST: W1/W2/W3 y huella intactos (no debilitados por W4-A) ──
DO $$
DECLARE
  v_src text;
BEGIN
  -- W1: registro de idempotencia presente
  IF to_regclass('public.business_operations') IS NULL THEN
    RAISE EXCEPTION 'CONTRATO FALLO: business_operations (W1) no existe';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'gestionar_membresia_socio' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('p_operation_key' IN v_src) = 0 THEN
    RAISE EXCEPTION 'CONTRATO FALLO: gestionar_membresia_socio perdió p_operation_key (W1)';
  END IF;

  -- W2: advisory lock de clase y FOR UPDATE en check-in
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'reservar_clase_atomic' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('clase_lugares:' IN v_src) = 0 THEN
    RAISE EXCEPTION 'CONTRATO FALLO: reservar_clase_atomic perdió el advisory lock (W2)';
  END IF;

  -- W3: trigger de protección de usuarios cubre membresia_tier
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'trg_proteger_usuarios' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('membresia_tier' IN v_src) = 0 THEN
    RAISE EXCEPTION 'CONTRATO FALLO: trg_proteger_usuarios perdió membresia_tier (W3)';
  END IF;

  -- Huella: sigue existiendo (W4-A no la toca)
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'check_in_por_huella') THEN
    RAISE EXCEPTION 'CONTRATO FALLO: check_in_por_huella desapareció';
  END IF;

  INSERT INTO _w4a_res VALUES (7, 'contract: W1/W2/W3 + huella intactos', 'OK');
END $$;

SELECT orden, prueba, resultado FROM _w4a_res ORDER BY orden;

COMMIT;
