-- ============================================================================
-- W6-B3 — INTENCIÓN DE COMPRA DURABLE (cierre del último gap de W6-B)
-- ----------------------------------------------------------------------------
-- Problema que cierra: un cobro off_session de la tienda podía, ante una falla
-- ambigua (Stripe acepta el cargo → se pierde la respuesta → el token del
-- cliente en localStorage se pierde → se reconstruye el carrito → token nuevo),
-- generar un SEGUNDO PaymentIntent para la MISMA compra.
--
-- Mecanismo mínimo: una intención de compra DURABLE server-side, establecida
-- ANTES del primer efecto económico. La clave de idempotencia de Stripe se
-- deriva del token de la intención; un token NUEVO con la misma huella inmutable
-- (tenant+socio+carrito+monto+moneda) mientras exista una intención ABIERTA se
-- trata como REINTENTO de esa intención (reusa su token → Stripe deduplica), no
-- como una compra nueva. Una compra genuinamente nueva sigue siendo posible
-- (la anterior tiene que estar RESUELTA).
--
-- Aditiva. service_role-only (el cliente nunca escribe la tabla). No toca
-- W6-A1/A2 ni W1-W5 ni la huella. Las migraciones las corre David (SQL Editor).
-- Rollback: DROP de las 2 funciones + DROP TABLE compra_intento.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS compra_intento (
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token                text NOT NULL,                       -- nonce de la acción (idempotency_token del cliente)
  usuario_id           uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  estado               text NOT NULL DEFAULT 'abierta'
                         CHECK (estado IN ('abierta','cobrada','fallida')),
  -- Huella INMUTABLE de la compra: congela la semántica para rechazar reusar el
  -- token con otro carrito/monto, y para reconocer un reintento con token perdido.
  carrito_fingerprint  text NOT NULL,
  monto_centavos       integer NOT NULL CHECK (monto_centavos > 0),
  moneda               text NOT NULL,
  payment_intent_id    text,                                -- PI resultante cuando se conoce
  resultado            jsonb,                               -- respuesta congelada para replay idempotente
  creado_en            timestamptz NOT NULL DEFAULT now(),
  actualizado_en       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, token)                            -- aislado por tenant (sin colisión cross-tenant)
);

-- Búsqueda de la intención ABIERTA por huella (reintento con token perdido).
CREATE INDEX IF NOT EXISTS ix_compra_intento_abierta
  ON compra_intento (tenant_id, usuario_id, carrito_fingerprint, monto_centavos, moneda)
  WHERE estado = 'abierta';

-- B3-6: el cliente NO puede leer ni mutar la intención. RLS sin policies →
-- authenticated/anon quedan denegados; service_role (BYPASSRLS) es el único que
-- entra, siempre vía las RPCs de abajo.
ALTER TABLE compra_intento ENABLE ROW LEVEL SECURITY;
ALTER TABLE compra_intento FORCE ROW LEVEL SECURITY;
REVOKE ALL ON compra_intento FROM PUBLIC, anon, authenticated;
GRANT ALL ON compra_intento TO service_role;

-- ----------------------------------------------------------------------------
-- RECLAMAR: establece/claima la intención durable ANTES de cobrar y devuelve el
-- token EFECTIVO a usar en la clave de Stripe. Congela el payload. Idempotente.
-- Devuelve jsonb { token, estado, reuso, resultado }.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compra_intento_reclamar(
  p_tenant uuid, p_usuario uuid, p_token text,
  p_fingerprint text, p_monto integer, p_moneda text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r compra_intento;
BEGIN
  IF p_tenant IS NULL OR p_usuario IS NULL OR p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'INTENTO_ARGS_INVALIDOS';
  END IF;
  IF p_fingerprint IS NULL OR p_fingerprint = '' OR p_monto IS NULL OR p_monto <= 0 OR p_moneda IS NULL THEN
    RAISE EXCEPTION 'INTENTO_ARGS_INVALIDOS';
  END IF;

  -- (1) ¿Existe por token? → reintento/replay del MISMO token.
  SELECT * INTO r FROM compra_intento
    WHERE tenant_id = p_tenant AND token = p_token FOR UPDATE;
  IF FOUND THEN
    IF r.usuario_id <> p_usuario THEN RAISE EXCEPTION 'INTENTO_DE_OTRO_USUARIO'; END IF;
    -- payload congelado: mismo token con carrito/monto/moneda distinto → rechazo.
    IF r.carrito_fingerprint <> p_fingerprint OR r.monto_centavos <> p_monto
       OR lower(r.moneda) <> lower(p_moneda) THEN
      RAISE EXCEPTION 'INTENTO_PAYLOAD_DISTINTO';
    END IF;
    RETURN jsonb_build_object('token', r.token, 'estado', r.estado, 'reuso', true, 'resultado', r.resultado);
  END IF;

  -- (2) Sin fila por token: ¿hay una intención ABIERTA con la MISMA huella?
  --     → el token se perdió (localStorage reset); es un reintento, no una
  --       compra nueva. Reusamos SU token como identidad de idempotencia.
  SELECT * INTO r FROM compra_intento
    WHERE tenant_id = p_tenant AND usuario_id = p_usuario
      AND carrito_fingerprint = p_fingerprint AND monto_centavos = p_monto
      AND lower(moneda) = lower(p_moneda) AND estado = 'abierta'
    ORDER BY creado_en DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('token', r.token, 'estado', 'abierta', 'reuso', true, 'resultado', NULL);
  END IF;

  -- (3) Compra nueva: crear la intención ANTES de cobrar.
  INSERT INTO compra_intento (tenant_id, token, usuario_id, estado, carrito_fingerprint, monto_centavos, moneda)
    VALUES (p_tenant, p_token, p_usuario, 'abierta', p_fingerprint, p_monto, lower(p_moneda));
  RETURN jsonb_build_object('token', p_token, 'estado', 'abierta', 'reuso', false, 'resultado', NULL);
END $$;

-- ----------------------------------------------------------------------------
-- RESOLVER: marca la intención como cobrada/fallida y congela el resultado para
-- replay. Solo actúa si sigue 'abierta' (idempotente ante reintentos).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compra_intento_resolver(
  p_tenant uuid, p_token text, p_estado text, p_pi text, p_resultado jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_estado NOT IN ('cobrada','fallida') THEN RAISE EXCEPTION 'INTENTO_ESTADO_INVALIDO'; END IF;
  UPDATE compra_intento
     SET estado = p_estado,
         payment_intent_id = COALESCE(p_pi, payment_intent_id),
         resultado = COALESCE(p_resultado, resultado),
         actualizado_en = now()
   WHERE tenant_id = p_tenant AND token = p_token AND estado = 'abierta';
END $$;

REVOKE ALL ON FUNCTION compra_intento_reclamar(uuid,uuid,text,text,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION compra_intento_reclamar(uuid,uuid,text,text,integer,text) TO service_role;
REVOKE ALL ON FUNCTION compra_intento_resolver(uuid,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION compra_intento_resolver(uuid,text,text,text,jsonb) TO service_role;

-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenants desechables.
-- ============================================================================
CREATE TEMP TABLE _w6b3_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $outer$
DECLARE
  v_slug  text := 'zz-w6b3-'||substr(md5(random()::text),1,6);
  v_slug2 text := 'zz-w6b3b-'||substr(md5(random()::text),1,6);
  v_t uuid; v_t2 uuid; v_u uuid; v_u2 uuid;
  v_fp text := 'fp_'||substr(md5(random()::text),1,10);
  v_tok1 text := 'tok1_'||substr(md5(random()::text),1,10);
  v_tok2 text := 'tok2_'||substr(md5(random()::text),1,10);
  v_tok3 text := 'tok3_'||substr(md5(random()::text),1,10);
  v_r jsonb; v_ok boolean;
BEGIN
  INSERT INTO tenants (slug,nombre,vertical,status,config) VALUES (v_slug,'W6B3','gym_libre','activo','{}'::jsonb) RETURNING id INTO v_t;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t,v_slug||'@x.dev','U','miembro','activo') RETURNING id INTO v_u;
  INSERT INTO tenants (slug,nombre,vertical,status,config) VALUES (v_slug2,'W6B3b','gym_libre','activo','{}'::jsonb) RETURNING id INTO v_t2;
  INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_t2,v_slug2||'@x.dev','U','miembro','activo') RETURNING id INTO v_u2;

  -- T1: intención creada ANTES del cobro (estado abierta, reuso=false, fila existe)
  v_r := compra_intento_reclamar(v_t, v_u, v_tok1, v_fp, 50000, 'mxn');
  IF (v_r->>'estado') <> 'abierta' OR (v_r->>'reuso')::boolean <> false THEN RAISE EXCEPTION 'T1: no creó abierta'; END IF;
  IF NOT EXISTS (SELECT 1 FROM compra_intento WHERE tenant_id=v_t AND token=v_tok1 AND estado='abierta') THEN RAISE EXCEPTION 'T1: no persistió'; END IF;
  INSERT INTO _w6b3_res VALUES (1,'intención durable creada antes del efecto (abierta)','OK');

  -- T2: mismo token, mismo payload → reintento (reuso=true, mismo token) → MISMA clave
  v_r := compra_intento_reclamar(v_t, v_u, v_tok1, v_fp, 50000, 'mxn');
  IF (v_r->>'token') <> v_tok1 OR (v_r->>'reuso')::boolean <> true THEN RAISE EXCEPTION 'T2: no reusó el token'; END IF;
  INSERT INTO _w6b3_res VALUES (2,'mismo token+payload → reintento reusa el mismo token (misma clave Stripe)','OK');

  -- T3: ALTERADO — mismo token, monto distinto → RECHAZA
  v_ok := false;
  BEGIN PERFORM compra_intento_reclamar(v_t, v_u, v_tok1, v_fp, 99999, 'mxn');
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'INTENTO_PAYLOAD_DISTINTO%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T3: payload alterado no fue rechazado'; END IF;
  INSERT INTO _w6b3_res VALUES (3,'payload alterado con el mismo token → RECHAZADO','OK');

  -- T4: token PERDIDO — token NUEVO con la misma huella y la intención sigue
  --     abierta → se adopta el token abierto (reintento, no compra nueva)
  v_r := compra_intento_reclamar(v_t, v_u, v_tok2, v_fp, 50000, 'mxn');
  IF (v_r->>'token') <> v_tok1 OR (v_r->>'reuso')::boolean <> true THEN RAISE EXCEPTION 'T4: no adoptó la intención abierta'; END IF;
  IF EXISTS (SELECT 1 FROM compra_intento WHERE tenant_id=v_t AND token=v_tok2) THEN RAISE EXCEPTION 'T4: creó fila nueva (doble cargo)'; END IF;
  INSERT INTO _w6b3_res VALUES (4,'token perdido + misma huella abierta → adopta la intención (sin segundo cargo)','OK');

  -- T5: RESOLVER cobrada → replay devuelve el resultado congelado, sin recobrar
  PERFORM compra_intento_resolver(v_t, v_tok1, 'cobrada', 'pi_test_1', '{"paid":true,"referencia":"pi_test_1"}'::jsonb);
  v_r := compra_intento_reclamar(v_t, v_u, v_tok1, v_fp, 50000, 'mxn');
  IF (v_r->>'estado') <> 'cobrada' OR (v_r->'resultado'->>'referencia') <> 'pi_test_1' THEN RAISE EXCEPTION 'T5: replay no devolvió el resultado'; END IF;
  INSERT INTO _w6b3_res VALUES (5,'resuelta cobrada → replay del resultado (no recobra)','OK');

  -- T6: compra NUEVA idéntica permitida — tras resolver, un token nuevo + misma
  --     huella crea una intención nueva (ya no hay abierta)
  v_r := compra_intento_reclamar(v_t, v_u, v_tok3, v_fp, 50000, 'mxn');
  IF (v_r->>'token') <> v_tok3 OR (v_r->>'reuso')::boolean <> false THEN RAISE EXCEPTION 'T6: no permitió compra nueva idéntica'; END IF;
  INSERT INTO _w6b3_res VALUES (6,'carrito idéntico como compra NUEVA (la previa resuelta) → permitido','OK');

  -- T7: cross-tenant — mismo token/huella en otro tenant → fila aislada, no colisiona
  v_r := compra_intento_reclamar(v_t2, v_u2, v_tok1, v_fp, 50000, 'mxn');
  IF (v_r->>'estado') <> 'abierta' OR (v_r->>'reuso')::boolean <> false THEN RAISE EXCEPTION 'T7: colisionó cross-tenant'; END IF;
  IF (SELECT count(*) FROM compra_intento WHERE token=v_tok1) <> 2 THEN RAISE EXCEPTION 'T7: no quedó aislado por tenant'; END IF;
  INSERT INTO _w6b3_res VALUES (7,'mismo token en otro tenant → aislado (sin colisión)','OK');

  -- limpieza (la tabla no es append-only; FK CASCADE, pero limpiamos explícito).
  DELETE FROM compra_intento WHERE tenant_id IN (v_t, v_t2);
  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug2);
END $outer$;

-- T8 (contrato/autoridad): el cliente no puede leer ni escribir la tabla.
DO $$
BEGIN
  IF has_table_privilege('authenticated','compra_intento','SELECT')
     OR has_table_privilege('authenticated','compra_intento','UPDATE')
     OR has_table_privilege('authenticated','compra_intento','INSERT')
     OR has_table_privilege('anon','compra_intento','SELECT') THEN
    RAISE EXCEPTION 'T8: authenticated/anon tiene acceso directo a compra_intento';
  END IF;
  IF has_function_privilege('authenticated','compra_intento_reclamar(uuid,uuid,text,text,integer,text)','EXECUTE')
     OR has_function_privilege('authenticated','compra_intento_resolver(uuid,text,text,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'T8: authenticated puede ejecutar las RPCs (deberían ser service_role-only)';
  END IF;
  INSERT INTO _w6b3_res VALUES (8,'autoridad: cliente sin acceso directo ni EXECUTE (service_role-only)','OK');
END $$;

SELECT orden, prueba, resultado FROM _w6b3_res ORDER BY orden;

COMMIT;
