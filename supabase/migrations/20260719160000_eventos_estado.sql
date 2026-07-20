-- ============================================================================
-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref `omrlbvhbggnrwwzlgxji`
--    (Healthy/HSC viven en `ltveorvqvvlyivjwxjlc`; Stryv en
--     `lxpgqhghxfqsahwrdmzo`. En el equivocado esto falla al instante
--     porque no existen `tenants` ni `suscripciones_saas`.)
-- ----------------------------------------------------------------------------
-- HISTORIAL DE ESTADOS — implementación de referencia del contrato de datos.
-- ----------------------------------------------------------------------------
-- EL PROBLEMA: hoy solo se guarda el estado ACTUAL de cada suscripción. Cuando
-- un gym cancela, `estado` pasa a 'cancelada' y se pierde PARA SIEMPRE el dato
-- de que antes estuvo activo, desde cuándo, y por qué se fue. Sin eso no existe
-- churn real, ni cohortes, ni conversión de prueba, ni LTV: son todas preguntas
-- sobre el PASADO, y el pasado no se está guardando.
--
-- Y no se recupera después. El histórico de los primeros meses —justo el que
-- dice si el negocio funciona— solo existe si se registra desde el primer gym.
--
-- POR QUÉ UN TRIGGER Y NO CÓDIGO EN LA APP: `suscripciones_saas.estado` se
-- escribe desde 6 funciones distintas (webhook, suscribir, cancelar, portal…),
-- desde varias migraciones, y desde UPDATEs manuales en el editor SQL. Cualquier
-- instrumentación en la aplicación deja caminos sin cubrir, y los que se escapan
-- son siempre los raros — que son los que importan. En la base no hay forma de
-- esquivarlo.
--
-- Ver docs del contrato en adminstryv/docs/CONTRATO-DATOS.md
-- ============================================================================

-- ── 1. La tabla ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eventos_estado (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Qué negocio del grupo lo generó. Acá siempre 'sala', pero el campo existe
  -- porque HSC y healthyspace comparten un mismo proyecto de Supabase.
  negocio       text NOT NULL,

  entidad       text NOT NULL,
  -- A PROPÓSITO sin FOREIGN KEY: si mañana se borra el tenant, su historia
  -- tiene que sobrevivir. Un evento pasado no deja de haber ocurrido porque
  -- la entidad ya no exista.
  entidad_id    uuid NOT NULL,

  de_estado     text,            -- NULL = nace (alta)
  a_estado      text NOT NULL,
  motivo        text,            -- opcional; ver `app.motivo` más abajo

  actor         uuid,            -- NULL = automático (webhook, cron, trigger)
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- clock_timestamp() y NO now(): now() devuelve la hora de INICIO de la
  -- transacción, igual para todas las filas escritas en ella. Dos cambios de
  -- estado en la misma transacción quedarían con el mismo instante y el
  -- historial perdería el orden — que es justamente lo único que un historial
  -- tiene que garantizar.
  ocurrido_en   timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Por si la tabla ya existía con el default viejo (`now()`).
ALTER TABLE eventos_estado
  ALTER COLUMN ocurrido_en SET DEFAULT clock_timestamp();

CREATE INDEX IF NOT EXISTS eventos_estado_entidad
  ON eventos_estado (negocio, entidad, entidad_id, ocurrido_en DESC);
-- Para las consultas del panel: "qué pasó en tal período".
CREATE INDEX IF NOT EXISTS eventos_estado_fecha
  ON eventos_estado (negocio, ocurrido_en DESC);

COMMENT ON TABLE eventos_estado IS
  'Historial inmutable de cambios de estado. Fuente de churn, cohortes y conversión. Se escribe por trigger, nunca a mano desde la app.';
COMMENT ON COLUMN eventos_estado.entidad_id IS
  'Sin FK a propósito: la historia sobrevive al borrado de la entidad.';

-- ── 2. Candado: la historia no se reescribe ─────────────────────────────────
-- UPDATE: jamás. Un evento pasado es un hecho.
-- DELETE: solo con la compuerta `app.purga_eventos`, que abre una función
-- explícita (purgar datos de prueba, o borrado por pedido del titular). Mismo
-- patrón que el candado de `pagos` + `cerrar_tenant` que ya existe en SALA.
CREATE OR REPLACE FUNCTION trg_eventos_estado_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.purga_eventos', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'EVENTOS_APPEND_ONLY: el historial no se edita ni se borra; es la fuente de churn y cohortes';
END;
$$;

DROP TRIGGER IF EXISTS eventos_estado_no_update ON eventos_estado;
CREATE TRIGGER eventos_estado_no_update
  BEFORE UPDATE OR DELETE ON eventos_estado
  FOR EACH ROW EXECUTE FUNCTION trg_eventos_estado_append_only();

-- ── 3. Seguridad: default-deny ──────────────────────────────────────────────
-- Nadie lo lee con el token del cliente. Solo service_role (backend y panel).
-- Es información de negocio del grupo, no del gym.
ALTER TABLE eventos_estado ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON eventos_estado FROM anon, authenticated;

-- ── 4. El registro automático ───────────────────────────────────────────────
-- Se dispara en el ALTA y en cada cambio REAL de `estado`. Un UPDATE que toca
-- otras columnas (precio, fechas de Stripe) NO genera evento: si no, el
-- historial se llena de ruido del webhook y deja de servir para contar churn.
--
-- El motivo se puede pasar desde la app con:
--     select set_config('app.motivo', 'pago_fallido', true);
-- antes del UPDATE (scope de transacción). Si no se pasa, queda NULL: preferimos
-- un motivo vacío antes que uno inventado por el trigger.
CREATE OR REPLACE FUNCTION trg_suscripciones_saas_evento()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_de    text := NULL;
  v_actor uuid := NULL;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.estado IS NOT DISTINCT FROM NEW.estado THEN
      RETURN NEW;  -- no cambió el estado: no es un evento
    END IF;
    v_de := OLD.estado;
  END IF;

  -- auth.uid() revienta si no hay JWT (ej. corriendo la migración a mano en el
  -- editor SQL). Nunca dejar que eso tumbe el UPDATE del negocio: sin sesión,
  -- el actor simplemente es NULL (automático).
  BEGIN
    v_actor := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  INSERT INTO eventos_estado (
    negocio, entidad, entidad_id, de_estado, a_estado, motivo, actor, metadata
  ) VALUES (
    'sala',
    'suscripcion_saas',
    NEW.tenant_id,              -- 1:1 con el tenant (tenant_id es UNIQUE)
    v_de,
    NEW.estado,
    nullif(current_setting('app.motivo', true), ''),
    v_actor,                    -- NULL cuando corre el webhook (service_role)
    jsonb_build_object(
      'tier', NEW.tier,
      'moneda', NEW.moneda,
      'precio_centavos', NEW.precio_centavos,
      -- Distinguir la suscripción real del placeholder del alta: sirve para
      -- separar "nunca puso tarjeta" de "puso tarjeta y después se fue".
      'llego_a_stripe', (NEW.stripe_subscription_id IS NOT NULL
                         AND NEW.stripe_subscription_id NOT LIKE 'mock_%')
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS suscripciones_saas_evento ON suscripciones_saas;
CREATE TRIGGER suscripciones_saas_evento
  AFTER INSERT OR UPDATE ON suscripciones_saas
  FOR EACH ROW EXECUTE FUNCTION trg_suscripciones_saas_evento();

-- ── 5. Backfill del estado actual ───────────────────────────────────────────
-- Las suscripciones que ya existen no tienen historia. No la podemos inventar,
-- pero sí dejar asentado su estado actual como punto de partida: sin esto, un
-- gym que cancele mañana aparecería cancelándose "desde la nada".
-- El motivo lo deja explícito para no confundirlo con un evento real.
INSERT INTO eventos_estado (negocio, entidad, entidad_id, de_estado, a_estado, motivo, metadata, ocurrido_en)
SELECT
  'sala', 'suscripcion_saas', s.tenant_id, NULL, s.estado, 'backfill_inicial',
  jsonb_build_object('tier', s.tier, 'moneda', s.moneda, 'precio_centavos', s.precio_centavos),
  coalesce(s.created_at, now())
FROM suscripciones_saas s
WHERE NOT EXISTS (
  SELECT 1 FROM eventos_estado e
  WHERE e.entidad = 'suscripcion_saas' AND e.entidad_id = s.tenant_id
);

-- ============================================================================
-- TEST — devuelve TABLA (el editor esconde los NOTICE).
-- ============================================================================
DROP TABLE IF EXISTS _res_eventos;
DO $$
DECLARE
  v_slug text := 'zz-test-eventos-' || substr(md5(random()::text), 1, 6);
  v_tid  uuid;
  v_n    int;
  v_ok   boolean;
BEGIN
  CREATE TEMP TABLE _res_eventos(caso text, esperado text, obtenido text, ok boolean) ON COMMIT PRESERVE ROWS;

  INSERT INTO tenants (slug, nombre) VALUES (v_slug, 'Test eventos') RETURNING id INTO v_tid;

  -- (1) El alta deja evento
  INSERT INTO suscripciones_saas (tenant_id, tier, moneda, estado, precio_centavos)
  VALUES (v_tid, 'starter', 'mxn', 'trial', 190000);
  SELECT count(*) INTO v_n FROM eventos_estado WHERE entidad_id = v_tid;
  INSERT INTO _res_eventos VALUES ('1 el alta deja evento', '1', v_n::text, v_n = 1);

  SELECT (de_estado IS NULL AND a_estado = 'trial') INTO v_ok
  FROM eventos_estado WHERE entidad_id = v_tid ORDER BY ocurrido_en LIMIT 1;
  INSERT INTO _res_eventos VALUES ('2 el alta va sin estado previo', 'true', v_ok::text, v_ok);

  -- (3) Cambiar de estado deja evento con de→a y motivo
  PERFORM set_config('app.motivo', 'pago_fallido', true);
  UPDATE suscripciones_saas SET estado = 'vencida' WHERE tenant_id = v_tid;
  -- Se busca por el evento de CAMBIO (el que tiene estado previo), no por
  -- "el más reciente": depender del orden temporal fue justo lo que hizo fallar
  -- esta prueba cuando ocurrido_en usaba now().
  SELECT (de_estado = 'trial' AND a_estado = 'vencida' AND motivo = 'pago_fallido') INTO v_ok
  FROM eventos_estado WHERE entidad_id = v_tid AND de_estado IS NOT NULL LIMIT 1;
  INSERT INTO _res_eventos VALUES ('3 el cambio registra de/a + motivo', 'true', v_ok::text, v_ok);

  -- (4) Tocar OTRA columna NO genera evento (si no, el webhook llena de ruido)
  PERFORM set_config('app.motivo', '', true);
  UPDATE suscripciones_saas SET precio_centavos = 200000 WHERE tenant_id = v_tid;
  SELECT count(*) INTO v_n FROM eventos_estado WHERE entidad_id = v_tid;
  INSERT INTO _res_eventos VALUES ('4 cambiar precio NO es evento', '2', v_n::text, v_n = 2);

  -- (5) El historial no se puede reescribir
  BEGIN
    UPDATE eventos_estado SET a_estado = 'trucho' WHERE entidad_id = v_tid;
    INSERT INTO _res_eventos VALUES ('5 no se puede editar el historial', 'bloqueado', 'PASO', false);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res_eventos VALUES ('5 no se puede editar el historial', 'bloqueado', 'bloqueado', true);
  END;

  -- Limpieza: abrir la compuerta solo para esto.
  PERFORM set_config('app.purga_eventos', 'on', true);
  DELETE FROM eventos_estado WHERE entidad_id = v_tid;
  PERFORM set_config('app.purga_eventos', 'off', true);
  DELETE FROM suscripciones_saas WHERE tenant_id = v_tid;
  DELETE FROM tenants WHERE id = v_tid;

  -- (6) Y que la compuerta haya vuelto a cerrarse. Se inserta una fila propia
  -- para probarlo: usar "la primera que haya" fallaría en falso si la tabla
  -- estuviera vacía (un DELETE que no toca filas no dispara el trigger).
  INSERT INTO eventos_estado (negocio, entidad, entidad_id, a_estado, motivo)
  VALUES ('sala', 'zz_test_compuerta', gen_random_uuid(), 'x', 'test');
  BEGIN
    DELETE FROM eventos_estado WHERE entidad = 'zz_test_compuerta';
    INSERT INTO _res_eventos VALUES ('6 la compuerta queda cerrada', 'bloqueado', 'PASO', false);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res_eventos VALUES ('6 la compuerta queda cerrada', 'bloqueado', 'bloqueado', true);
  END;

  -- Esa fila de prueba sí hay que sacarla, con la compuerta abierta.
  PERFORM set_config('app.purga_eventos', 'on', true);
  DELETE FROM eventos_estado WHERE entidad = 'zz_test_compuerta';
  PERFORM set_config('app.purga_eventos', 'off', true);
END $$;

SELECT caso, esperado, obtenido, CASE WHEN ok THEN 'OK' ELSE '*** FALLO ***' END AS resultado
FROM _res_eventos ORDER BY caso;