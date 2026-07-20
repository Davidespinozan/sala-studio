-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- MOVIMIENTOS_DINERO — el libro contable de lo que SALA cobra
-- ============================================================================
-- POR QUÉ EXISTE: hasta hoy, el dinero que los gyms le pagan a SALA no queda
-- registrado en ningún lado. El webhook recibe `invoice.paid` de Stripe con el
-- monto adentro y lo descarta: solo actualiza `payment_past_due`
-- (netlify/functions/stripe-webhook-saas/index.ts). El ingreso propio de SALA
-- existe únicamente dentro de Stripe.
--
-- Eso hace imposible responder preguntas básicas del negocio: cuánto facturé
-- este mes, cuánto vale cada tenant, cuál es mi MRR real cobrado (no el
-- prometido), qué cobros fallaron. Y Stripe no sirve como fuente: no se puede
-- cruzar con el resto de los datos, y si algún día se cambia de proveedor la
-- historia se va con él.
--
-- QUÉ NO ES: esto NO es la tabla `pagos`. `pagos` es el dinero que los SOCIOS
-- le pagan a los GYMS — volumen que pasa por la plataforma pero no es de SALA
-- (la comisión es 0). Esta tabla es el dinero de SALA. Son dos negocios
-- distintos y mezclarlos da una cifra que no significa nada.
--
-- FORMATO: sigue el contrato común de los negocios del grupo, para que el hub
-- consolidado lea igual a todos (adminstryv/docs/CONTRATO-DATOS.md).
-- ============================================================================

CREATE TABLE IF NOT EXISTS movimientos_dinero (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Qué negocio del grupo lo generó. Acá siempre 'sala', pero la columna
  -- existe porque hay bases compartidas (HSC y healthyspace viven juntos).
  negocio         text NOT NULL DEFAULT 'sala',

  ocurrido_en     timestamptz NOT NULL DEFAULT now(),

  -- SIEMPRE centavos enteros. Un float en dinero termina en descuadres de un
  -- centavo que nadie encuentra nunca.
  -- PUEDE SER NEGATIVO: un reembolso es OTRA FILA, no un UPDATE. Eso es lo que
  -- hace que el saldo sea la suma y nada más.
  monto_centavos  bigint NOT NULL,
  moneda          text NOT NULL CHECK (moneda IN ('MXN', 'USD', 'EUR')),

  concepto        text NOT NULL CHECK (concepto IN ('suscripcion', 'reembolso', 'ajuste')),
  metodo          text NOT NULL CHECK (metodo IN ('stripe', 'transferencia', 'cortesia')),

  -- Id de Stripe (invoice). Doble función: rastro hacia afuera Y llave de
  -- idempotencia. Stripe REINTENTA los webhooks; sin esto, un reintento
  -- duplica el ingreso y todos los números quedan inflados en silencio.
  referencia_externa text,

  -- A qué gym se le cobró.
  tenant_id       uuid REFERENCES tenants(id) ON DELETE SET NULL,

  -- Quién lo registró. NULL = cobro automático de Stripe.
  actor           uuid REFERENCES auth.users(id),

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- La llave de idempotencia. Parcial porque un ajuste manual puede no tener
-- referencia externa, y varios NULL no deben colisionar entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS movimientos_dinero_ref_unica
  ON movimientos_dinero (negocio, referencia_externa)
  WHERE referencia_externa IS NOT NULL;

CREATE INDEX IF NOT EXISTS movimientos_dinero_fecha
  ON movimientos_dinero (negocio, ocurrido_en DESC);

CREATE INDEX IF NOT EXISTS movimientos_dinero_tenant
  ON movimientos_dinero (tenant_id, ocurrido_en DESC);

-- ── Append-only, con candado real ───────────────────────────────────────────
-- No es burocracia: es lo que hace que el ingreso del mes pasado sea el mismo
-- hoy que dentro de un año. Sin esto, cualquier UPDATE reescribe la historia y
-- los cierres dejan de cuadrar sin que nadie se entere.
-- Mismo patrón que `pagos` (20260713100000) y `eventos_estado` (20260719160000).
CREATE OR REPLACE FUNCTION trg_movimientos_dinero_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Escape hatch para el cierre de tenant, igual que en `pagos`.
  IF current_setting('sala.cierre_tenant', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'MOVIMIENTOS_APPEND_ONLY: un movimiento de dinero no se edita ni se borra; registrá un asiento de correccion (monto negativo)';
END; $$;

DROP TRIGGER IF EXISTS movimientos_dinero_no_update ON movimientos_dinero;
CREATE TRIGGER movimientos_dinero_no_update
  BEFORE UPDATE OR DELETE ON movimientos_dinero
  FOR EACH ROW EXECUTE FUNCTION trg_movimientos_dinero_append_only();

-- ── Seguridad: default-deny ─────────────────────────────────────────────────
-- Esta tabla cruza tenants: contiene lo que paga CADA gym. Ningún gym puede
-- ver la de otro, y ningún usuario del navegador tiene por qué leerla. La
-- escribe el webhook y la lee el hub, ambos con service_role.
ALTER TABLE movimientos_dinero ENABLE ROW LEVEL SECURITY;

-- Supabase concede EXECUTE/permisos a `authenticated` por default: hay que
-- revocar explícitamente los tres roles, no alcanza con no crear políticas.
REVOKE ALL ON movimientos_dinero FROM PUBLIC;
REVOKE ALL ON movimientos_dinero FROM anon;
REVOKE ALL ON movimientos_dinero FROM authenticated;

COMMENT ON TABLE movimientos_dinero IS
  'Libro contable de lo que SALA cobra a los gyms. Append-only, centavos enteros, idempotente por referencia_externa (invoice de Stripe). NO confundir con `pagos`, que es el dinero socio→gym.';

-- ============================================================================
-- TESTS — devuelven TABLA (el editor de Supabase esconde los NOTICE)
-- ============================================================================
DROP TABLE IF EXISTS _res_movs;

DO $$
DECLARE
  v_tenant uuid;
  v_ok boolean;
BEGIN
  -- PRESERVE ROWS, no ON COMMIT DROP: si no, la tabla se va antes del SELECT
  -- final y el editor no muestra nada.
  CREATE TEMP TABLE _res_movs(n int, prueba text, resultado text) ON COMMIT PRESERVE ROWS;

  SELECT id INTO v_tenant FROM tenants LIMIT 1;

  -- 1. Se puede insertar un cobro
  INSERT INTO movimientos_dinero (monto_centavos, moneda, concepto, metodo, referencia_externa, tenant_id)
  VALUES (99900, 'MXN', 'suscripcion', 'stripe', '_test_in_1', v_tenant);
  INSERT INTO _res_movs VALUES (1, 'Registrar un cobro', 'OK');

  -- 2. La idempotencia frena el duplicado (el reintento de Stripe)
  BEGIN
    INSERT INTO movimientos_dinero (monto_centavos, moneda, concepto, metodo, referencia_externa, tenant_id)
    VALUES (99900, 'MXN', 'suscripcion', 'stripe', '_test_in_1', v_tenant);
    INSERT INTO _res_movs VALUES (2, 'Un reintento de Stripe NO duplica', 'FALLA: se duplico');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _res_movs VALUES (2, 'Un reintento de Stripe NO duplica', 'OK');
  END;

  -- 3. No se puede editar
  BEGIN
    UPDATE movimientos_dinero SET monto_centavos = 1 WHERE referencia_externa = '_test_in_1';
    INSERT INTO _res_movs VALUES (3, 'No se puede editar un movimiento', 'FALLA: dejo editar');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res_movs VALUES (3, 'No se puede editar un movimiento', 'OK');
  END;

  -- 4. No se puede borrar
  BEGIN
    DELETE FROM movimientos_dinero WHERE referencia_externa = '_test_in_1';
    INSERT INTO _res_movs VALUES (4, 'No se puede borrar un movimiento', 'FALLA: dejo borrar');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res_movs VALUES (4, 'No se puede borrar un movimiento', 'OK');
  END;

  -- 5. Un reembolso es otra fila, con monto negativo
  INSERT INTO movimientos_dinero (monto_centavos, moneda, concepto, metodo, referencia_externa, tenant_id)
  VALUES (-99900, 'MXN', 'reembolso', 'stripe', '_test_in_2', v_tenant);
  SELECT sum(monto_centavos) = 0 INTO v_ok FROM movimientos_dinero
  WHERE referencia_externa IN ('_test_in_1', '_test_in_2');
  INSERT INTO _res_movs VALUES (5, 'Un reembolso deja el saldo en cero', CASE WHEN v_ok THEN 'OK' ELSE 'FALLA' END);

  -- 6. Moneda invalida se rechaza
  BEGIN
    INSERT INTO movimientos_dinero (monto_centavos, moneda, concepto, metodo, tenant_id)
    VALUES (100, 'ARS', 'suscripcion', 'stripe', v_tenant);
    INSERT INTO _res_movs VALUES (6, 'Una moneda desconocida se rechaza', 'FALLA: la acepto');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _res_movs VALUES (6, 'Una moneda desconocida se rechaza', 'OK');
  END;

  -- Limpieza (usando el escape hatch, que para eso existe)
  PERFORM set_config('sala.cierre_tenant', 'on', true);
  DELETE FROM movimientos_dinero WHERE referencia_externa LIKE '_test_in_%';
  PERFORM set_config('sala.cierre_tenant', 'off', true);
END $$;

SELECT n AS "#", prueba, resultado FROM _res_movs ORDER BY n;