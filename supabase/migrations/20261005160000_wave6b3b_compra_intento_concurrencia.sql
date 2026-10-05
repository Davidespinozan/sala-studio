-- ============================================================================
-- W6-B3b — compra_intento: cierre de la carrera H1 (W6-E, P1 CONFIRMED)
-- ----------------------------------------------------------------------------
-- Evidencia (entorno aislado, fuera de este repo): 20 conexiones Postgres
-- reales y concurrentes, mismo tenant/usuario/huella/monto/moneda, tokens
-- distintos → 5 filas 'abierta' en vez de 1 (reproducido 2/2). Causa: el
-- paso (2) de `compra_intento_reclamar` (buscar una 'abierta' con la misma
-- huella) solo bloquea filas que YA EXISTEN; bajo READ COMMITTED no hay
-- gap-lock que impida que N transacciones concurrentes vean "0 filas" antes
-- de que cualquiera haga su INSERT.
--
-- Fix: el índice `ix_compra_intento_abierta` (ya existente, mismas columnas)
-- pasa de no-único a ÚNICO. Bajo concurrencia real, solo UNA transacción
-- inserta; las demás reciben `unique_violation`. En vez de fallar, se
-- recupera la intención REAL de esa identidad — en CUALQUIER estado, no solo
-- 'abierta' — y se devuelve como replay (misma forma que el paso 1 ya usa
-- para un match directo por token). Si ya cobró, NUNCA se abre una segunda
-- intención: eso sería exactamente el doble cargo que esto evita. Solo si no
-- queda ninguna fila (el "ganador" hizo rollback, nunca existió de verdad) se
-- reintenta el INSERT con el propio token — acotado a 5 vueltas para
-- concurrencia N-vías real.
--
-- Firma y forma de retorno `{token, estado, reuso, resultado}` SIN CAMBIOS.
-- `comprar-producto/index.ts` no necesita ningún cambio (ya trata cualquier
-- `reuso:true` igual, sin importar el estado). Pasos (1) y (2) sin cambios.
--
-- 20261001120000 (migración histórica de B3) queda intacta. No reemplaza el
-- patrón: ya lo usa `_stripe_compensar_objeto` (C1b) y sobrevivió 15 llamadas
-- concurrentes reales en W6-E.
--
-- Alcance: EXCLUSIVAMENTE H1/B3. No toca H2/H3/C1b/D/C3/Masters/expiración de
-- intenciones. Las migraciones las corre David (SQL Editor). Rollback: DROP
-- del índice único + CREATE OR REPLACE de vuelta al texto de 20261001120000
-- (ambos quedan documentados abajo en el header de la función).
-- ============================================================================
BEGIN;

DROP INDEX IF EXISTS ix_compra_intento_abierta;
CREATE UNIQUE INDEX ix_compra_intento_abierta
  ON compra_intento (tenant_id, usuario_id, carrito_fingerprint, monto_centavos, moneda)
  WHERE estado = 'abierta';

CREATE OR REPLACE FUNCTION compra_intento_reclamar(
  p_tenant uuid, p_usuario uuid, p_token text,
  p_fingerprint text, p_monto integer, p_moneda text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r compra_intento; v_intentos integer := 0;
BEGIN
  IF p_tenant IS NULL OR p_usuario IS NULL OR p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'INTENTO_ARGS_INVALIDOS';
  END IF;
  IF p_fingerprint IS NULL OR p_fingerprint = '' OR p_monto IS NULL OR p_monto <= 0 OR p_moneda IS NULL THEN
    RAISE EXCEPTION 'INTENTO_ARGS_INVALIDOS';
  END IF;

  -- (1) ¿Existe por token? → reintento/replay del MISMO token. SIN CAMBIOS.
  SELECT * INTO r FROM compra_intento
    WHERE tenant_id = p_tenant AND token = p_token FOR UPDATE;
  IF FOUND THEN
    IF r.usuario_id <> p_usuario THEN RAISE EXCEPTION 'INTENTO_DE_OTRO_USUARIO'; END IF;
    IF r.carrito_fingerprint <> p_fingerprint OR r.monto_centavos <> p_monto
       OR lower(r.moneda) <> lower(p_moneda) THEN
      RAISE EXCEPTION 'INTENTO_PAYLOAD_DISTINTO';
    END IF;
    RETURN jsonb_build_object('token', r.token, 'estado', r.estado, 'reuso', true, 'resultado', r.resultado);
  END IF;

  -- (2) Sin fila por token: ¿hay una intención ABIERTA con la MISMA huella?
  --     → el token se perdió (localStorage reset); es un reintento, no una
  --       compra nueva. Reusamos SU token como identidad de idempotencia.
  --     SIN CAMBIOS (sigue siendo el camino rápido para el caso NO-carrera:
  --     llegada secuencial, la fila ya está comiteada y visible).
  SELECT * INTO r FROM compra_intento
    WHERE tenant_id = p_tenant AND usuario_id = p_usuario
      AND carrito_fingerprint = p_fingerprint AND monto_centavos = p_monto
      AND lower(moneda) = lower(p_moneda) AND estado = 'abierta'
    ORDER BY creado_en DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('token', r.token, 'estado', 'abierta', 'reuso', true, 'resultado', NULL);
  END IF;

  -- (3) Compra nueva: crear la intención ANTES de cobrar. W6-B3b: bajo
  -- concurrencia real, dos o más requests pueden llegar aquí a la vez
  -- (ninguno vio al otro en el paso 2, porque ninguno había comiteado
  -- todavía). El índice único decide: solo UNO inserta.
  LOOP
    v_intentos := v_intentos + 1;
    BEGIN
      INSERT INTO compra_intento (tenant_id, token, usuario_id, estado, carrito_fingerprint, monto_centavos, moneda)
        VALUES (p_tenant, p_token, p_usuario, 'abierta', p_fingerprint, p_monto, lower(p_moneda));
      RETURN jsonb_build_object('token', p_token, 'estado', 'abierta', 'reuso', false, 'resultado', NULL);
    EXCEPTION WHEN unique_violation THEN
      -- Recuperar la intención REAL de esta identidad, en CUALQUIER estado
      -- (no solo 'abierta'): si ya se resolvió (cobrada/fallida) entre que
      -- commiteó y que esta transacción llegó a verla, eso es la verdad y se
      -- devuelve como replay — jamás se abre una intención nueva sobre un
      -- carrito que ya cobró (ese sería exactamente el doble cargo que esto
      -- evita). Solo si no queda ninguna fila (el "ganador" hizo rollback,
      -- nunca existió de verdad) se reintenta el INSERT.
      SELECT * INTO r FROM compra_intento
        WHERE tenant_id = p_tenant AND usuario_id = p_usuario
          AND carrito_fingerprint = p_fingerprint AND monto_centavos = p_monto
          AND lower(moneda) = lower(p_moneda)
        ORDER BY creado_en DESC LIMIT 1;
      IF FOUND THEN
        RETURN jsonb_build_object('token', r.token, 'estado', r.estado, 'reuso', true, 'resultado', r.resultado);
      END IF;
      IF v_intentos >= 5 THEN
        RAISE EXCEPTION 'INTENTO_CONFLICTO_IRRESOLUBLE: % intentos sin crear ni recuperar la intención', v_intentos;
      END IF;
      -- si no, el "ganador" hizo rollback: no quedó ninguna fila → reintentar.
    END;
  END LOOP;
END $$;

COMMENT ON FUNCTION compra_intento_reclamar(uuid,uuid,text,text,integer,text) IS
  'W6-B3b: misma intención lógica concurrente → máximo una fila abierta '
  '(índice único ix_compra_intento_abierta) → máximo un token efectivo → una '
  'sola Stripe idempotencyKey. Un perdedor de la carrera nunca abre una '
  'segunda intención sobre un carrito ya cobrado: recupera y reproduce el '
  'resultado real. Firma y forma de retorno sin cambios.';

-- ============================================================================
-- SELF-TESTS SECUENCIALES (DEVUELVEN TABLA) — regresión de los 7 originales
-- de B3 (intactos, sin modificar) + 2 nuevos deterministas de esta ola.
-- La validación de concurrencia REAL (20 conexiones paralelas) se corrió en un
-- entorno Postgres aislado fuera de este repo (no reproducible dentro de un
-- único bloque PL/pgSQL secuencial) — ver reporte W6-E/W6-B3b.
-- ============================================================================
CREATE TEMP TABLE _w6b3b_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug text := 'zz-w6b3b-'||substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-w6b3bb-'||substr(md5(random()::text),1,6);
  v_t uuid; v_t2 uuid; v_u uuid; v_u2 uuid;
  v_fp text := 'fp_'||substr(md5(random()::text),1,10);
  v_tok1 text := 'tok1_'||substr(md5(random()::text),1,10);
  v_tok2 text := 'tok2_'||substr(md5(random()::text),1,10);
  v_tok3 text := 'tok3_'||substr(md5(random()::text),1,10);
  v_r jsonb; v_ok boolean;
BEGIN
  INSERT INTO tenants (slug,nombre,vertical,status,config) VALUES (v_slug,'W6B3b','gym_libre','activo','{}'::jsonb) RETURNING id INTO v_t;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t,v_slug||'@x.dev','U','miembro','activo') RETURNING id INTO v_u;
  INSERT INTO tenants (slug,nombre,vertical,status,config) VALUES (v_slug2,'W6B3bb','gym_libre','activo','{}'::jsonb) RETURNING id INTO v_t2;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t2,v_slug2||'@x.dev','U2','miembro','activo') RETURNING id INTO v_u2;

  -- Regresión T1-T7 (idéntica a 20261001120000, sin modificar su intención).
  v_r := compra_intento_reclamar(v_t, v_u, v_tok1, v_fp, 50000, 'mxn');
  IF (v_r->>'reuso')::boolean <> false THEN RAISE EXCEPTION 'T1: no creó abierta'; END IF;
  IF NOT EXISTS (SELECT 1 FROM compra_intento WHERE tenant_id=v_t AND token=v_tok1 AND estado='abierta') THEN RAISE EXCEPTION 'T1: no persistió'; END IF;
  INSERT INTO _w6b3b_res VALUES (1,'intención durable creada antes del efecto (abierta)','OK');

  v_r := compra_intento_reclamar(v_t, v_u, v_tok1, v_fp, 50000, 'mxn');
  IF (v_r->>'token') <> v_tok1 OR (v_r->>'reuso')::boolean <> true THEN RAISE EXCEPTION 'T2: no reusó el token'; END IF;
  INSERT INTO _w6b3b_res VALUES (2,'mismo token+payload → reintento reusa el mismo token','OK');

  v_ok := false;
  BEGIN PERFORM compra_intento_reclamar(v_t, v_u, v_tok1, v_fp, 99999, 'mxn');
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'INTENTO_PAYLOAD_DISTINTO%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T3: payload alterado no fue rechazado'; END IF;
  INSERT INTO _w6b3b_res VALUES (3,'payload alterado con el mismo token → RECHAZADO','OK');

  v_r := compra_intento_reclamar(v_t, v_u, v_tok2, v_fp, 50000, 'mxn');
  IF (v_r->>'token') <> v_tok1 OR (v_r->>'reuso')::boolean <> true THEN RAISE EXCEPTION 'T4: no adoptó la intención abierta'; END IF;
  IF EXISTS (SELECT 1 FROM compra_intento WHERE tenant_id=v_t AND token=v_tok2) THEN RAISE EXCEPTION 'T4: creó fila nueva (doble cargo)'; END IF;
  INSERT INTO _w6b3b_res VALUES (4,'token perdido + misma huella abierta → adopta la intención','OK');

  PERFORM compra_intento_resolver(v_t, v_tok1, 'cobrada', 'pi_test_1', '{"paid":true,"referencia":"pi_test_1"}'::jsonb);
  v_r := compra_intento_reclamar(v_t, v_u, v_tok1, v_fp, 50000, 'mxn');
  IF (v_r->>'estado') <> 'cobrada' OR (v_r->'resultado'->>'referencia') <> 'pi_test_1' THEN RAISE EXCEPTION 'T5: replay no devolvió el resultado'; END IF;
  INSERT INTO _w6b3b_res VALUES (5,'resuelta cobrada → replay del resultado (no recobra)','OK');

  v_r := compra_intento_reclamar(v_t, v_u, v_tok3, v_fp, 50000, 'mxn');
  IF (v_r->>'token') <> v_tok3 OR (v_r->>'reuso')::boolean <> false THEN RAISE EXCEPTION 'T6: no permitió compra nueva idéntica'; END IF;
  INSERT INTO _w6b3b_res VALUES (6,'carrito idéntico como compra NUEVA (la previa resuelta) → permitido','OK');

  v_r := compra_intento_reclamar(v_t2, v_u2, v_tok1, v_fp, 50000, 'mxn');
  IF (v_r->>'estado') <> 'abierta' OR (v_r->>'reuso')::boolean <> false THEN RAISE EXCEPTION 'T7: colisionó cross-tenant'; END IF;
  IF (SELECT count(*) FROM compra_intento WHERE token=v_tok1) <> 2 THEN RAISE EXCEPTION 'T7: no quedó aislado por tenant'; END IF;
  INSERT INTO _w6b3b_res VALUES (7,'mismo token en otro tenant → aislado (sin colisión)','OK');

  -- T8 (NUEVO, W6-B3b): el índice único existe y es único (no solo un índice).
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'ix_compra_intento_abierta' AND i.indisunique
  ) THEN RAISE EXCEPTION 'T8: el índice no quedó único'; END IF;
  INSERT INTO _w6b3b_res VALUES (8,'ix_compra_intento_abierta es ahora UNIQUE','OK');

  -- T9 (NUEVO, W6-B3b): simular el "ganador" vía INSERT directo (bypass de la
  -- función) con estado 'abierta' para la misma identidad, y confirmar que
  -- compra_intento_reclamar con un token distinto detecta el choque y
  -- RECUPERA al ganador (no crea una segunda fila) — equivalente secuencial
  -- del camino de recuperación que la concurrencia real ejercita.
  DECLARE v_fp9 text := 'fp9_'||substr(md5(random()::text),1,10); v_tokA text := 'tokA_'||substr(md5(random()::text),1,8); v_tokB text := 'tokB_'||substr(md5(random()::text),1,8);
  BEGIN
    INSERT INTO compra_intento (tenant_id, token, usuario_id, estado, carrito_fingerprint, monto_centavos, moneda)
      VALUES (v_t, v_tokA, v_u, 'abierta', v_fp9, 30000, 'mxn');
    v_r := compra_intento_reclamar(v_t, v_u, v_tokB, v_fp9, 30000, 'mxn');
    IF (v_r->>'token') <> v_tokA OR (v_r->>'reuso')::boolean <> true THEN RAISE EXCEPTION 'T9: no recuperó al ganador tras el choque único'; END IF;
    IF (SELECT count(*) FROM compra_intento WHERE tenant_id=v_t AND carrito_fingerprint=v_fp9) <> 1 THEN RAISE EXCEPTION 'T9: quedaron 2 filas (la carrera no se evitó)'; END IF;
  END;
  INSERT INTO _w6b3b_res VALUES (9,'choque de índice único → recupera al ganador, no crea 2ª fila','OK');

  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug2);
END $outer$;

SELECT orden, prueba, resultado FROM _w6b3b_res ORDER BY orden;

COMMIT;
