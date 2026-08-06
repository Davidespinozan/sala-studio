-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- MULTA POR RE-RESERVAR TRAS NO-SHOW  (Modelo A)
-- ────────────────────────────────────────────────────────────────────────────
-- numa: con tope de 1 reserva/día, si el socio FALTÓ (no_show) a su clase y quiere
-- reservar OTRA el mismo día, se le permite pagando una multa (default $75). Si no
-- re-reserva, no hay multa. Se cobra en mostrador cuando llega. La multa es el
-- "precio" de la segunda oportunidad, no un castigo automático por faltar.
--
-- Convive con un futuro "Modelo B" (multa automática por no cancelar y faltar):
-- son toggles INDEPENDIENTES en config.penalizaciones y se disparan en momentos
-- distintos (A al reservar, B al detectar el no-show). Este archivo solo cablea el
-- Modelo A y lo deja APAGADO por default → nada cambia hasta que el gym lo prenda
-- en Ajustes → Reglas.
--
-- Config (jsonb en tenants):
--   config.penalizaciones.multa_rereserva_activa    bool  (default false)
--   config.penalizaciones.multa_rereserva_centavos  int   (default 7500 = $75)
--
-- Cómo decide el trigger del tope diario:
--   • Debajo del tope contando TODO           → permite normal.
--   • Al tope por reservas VIVAS (confirmada/  → bloquea (LIMITE_DIARIO): ya usó su
--     completada)                                 cupo de verdad, la multa no aplica.
--   • Al tope SOLO por no_show(s):
--       – Modelo A apagado                     → bloquea (LIMITE_DIARIO), como hoy.
--       – Modelo A activo, sin aceptar         → MULTA_REQUERIDA: <centavos>  (la app
--                                                 muestra el modal de confirmación).
--       – Modelo A activo, aceptada            → permite y estampa multa en la reserva.
--
-- La app avisa que aceptó poniendo un flag por transacción antes de insertar:
--   SELECT set_config('sala.acepta_multa','on', true);
-- (esa parte va en el RPC de reservar — pieza aparte).
-- ════════════════════════════════════════════════════════════════════════════

-- 1) La multa vive con la reserva que la generó.
ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS multa_centavos int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS multa_pagada   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS multa_pago_id  uuid REFERENCES pagos(id) ON DELETE SET NULL;

ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_multa_centavos_valida;
ALTER TABLE reservas ADD CONSTRAINT reservas_multa_centavos_valida
  CHECK (multa_centavos >= 0);

-- Recepción encuentra las multas pendientes por cobrar rápido.
CREATE INDEX IF NOT EXISTS reservas_multa_pendiente_idx
  ON reservas (tenant_id)
  WHERE multa_centavos > 0 AND NOT multa_pagada;

COMMENT ON COLUMN reservas.multa_centavos IS
  'Multa (Modelo A) que esta reserva asumió por re-reservar el mismo día tras un no-show. 0 = sin multa.';
COMMENT ON COLUMN reservas.multa_pagada IS
  'La multa de esta reserva ya se cobró (en mostrador / Caja). Sin multa (0) queda en false y se ignora.';

-- 2) Trigger del tope diario: ahora distingue no_show y aplica el Modelo A.
CREATE OR REPLACE FUNCTION verificar_limite_diario_reserva()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max int;
  v_tz text;
  v_dia date;
  v_total int;   -- reservas NO canceladas del día (no_show incluidos)
  v_vivas int;   -- NO canceladas y NO no_show → cupo realmente usado
  v_activa boolean;
  v_centavos int;
  v_acepta boolean;
BEGIN
  SELECT t.max_reservas_dia INTO v_max
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_max IS NULL OR v_max < 1 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(config->>'timezone', 'America/Mexico_City') INTO v_tz
  FROM tenants WHERE id = NEW.tenant_id;
  v_dia := (NEW.slot_inicio AT TIME ZONE v_tz)::date;

  SELECT
    count(*) FILTER (WHERE status <> 'cancelada'),
    count(*) FILTER (WHERE status NOT IN ('cancelada', 'no_show'))
  INTO v_total, v_vivas
  FROM reservas
  WHERE usuario_id = NEW.usuario_id
    AND (slot_inicio AT TIME ZONE v_tz)::date = v_dia;

  -- Debajo del tope contando TODO → permite normal.
  IF v_total < v_max THEN
    RETURN NEW;
  END IF;

  -- Al tope por reservas VIVAS → bloquea: ya usó su cupo de verdad, la multa no aplica.
  IF v_vivas >= v_max THEN
    RAISE EXCEPTION 'LIMITE_DIARIO: Tu plan permite % reserva(s) por día', v_max;
  END IF;

  -- Al tope SOLO por no_show(s) → entra el Modelo A.
  SELECT
    COALESCE((config->'penalizaciones'->>'multa_rereserva_activa')::boolean, false),
    COALESCE((config->'penalizaciones'->>'multa_rereserva_centavos')::int, 7500)
  INTO v_activa, v_centavos
  FROM tenants WHERE id = NEW.tenant_id;

  -- Modelo A apagado → comportamiento de siempre.
  IF NOT v_activa THEN
    RAISE EXCEPTION 'LIMITE_DIARIO: Tu plan permite % reserva(s) por día', v_max;
  END IF;

  -- ¿El socio ya aceptó la multa? (flag por transacción que pone el RPC de reservar)
  v_acepta := COALESCE(current_setting('sala.acepta_multa', true), '') = 'on';
  IF NOT v_acepta THEN
    -- Señal para la app: falta confirmar la multa. El monto (centavos) va en el mensaje.
    RAISE EXCEPTION 'MULTA_REQUERIDA: %', v_centavos;
  END IF;

  -- Aceptó → estampar la multa en la reserva y permitir.
  NEW.multa_centavos := v_centavos;
  NEW.multa_pagada := false;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS reservas_limite_diario ON reservas;
CREATE TRIGGER reservas_limite_diario
  BEFORE INSERT ON reservas
  FOR EACH ROW EXECUTE FUNCTION verificar_limite_diario_reserva();

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — se auto-verifica y revierte (sentinel). El SELECT final devuelve TABLA.
--   1) 2da reserva con la 1ra VIVA           → LIMITE_DIARIO (no cambia).
--   2) 1ra no_show + Modelo A on, sin aceptar → MULTA_REQUERIDA.
--   3) 1ra no_show + Modelo A on, aceptada    → permite y estampa 7500.
-- (Todo con un tenant real pero dentro de un savepoint que se revierte al final.)
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_recurso uuid; v_tz text;
  v_dia date; v_s1 timestamptz; v_s2 timestamptz; v_s3 timestamptz;
  v_r1 uuid; v_multa int := -1;
  v_ok1 boolean := false; v_ok2 boolean := false; v_ok3 boolean := false;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: sin tenant.'; RETURN; END IF;
  SELECT id INTO v_recurso FROM recursos WHERE tenant_id = v_tenant LIMIT 1;
  IF v_recurso IS NULL THEN RAISE NOTICE 'TEST SKIP: sin recurso.'; RETURN; END IF;
  v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id=v_tenant), 'America/Mexico_City');

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, 'multa-test@example.com', 'Multa Test', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, max_reservas_dia, activo, orden)
  VALUES (v_tenant, 'multa-test', 'Multa Test', 'tiempo', 100000, 'MXN', 30, 1, true, 999)
  RETURNING id INTO v_tier;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days');

  v_dia := (now() AT TIME ZONE v_tz)::date + 3;
  v_s1 := (v_dia + time '10:00') AT TIME ZONE v_tz;
  v_s2 := (v_dia + time '11:00') AT TIME ZONE v_tz;
  v_s3 := (v_dia + time '12:00') AT TIME ZONE v_tz;

  -- 1ra reserva del día
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
  VALUES (v_tenant, v_recurso, v_socio, v_s1, v_s1 + interval '1 hour', 60, 'TEST-MUL-1', 'confirmada')
  RETURNING id INTO v_r1;

  -- (1) 2da con la 1ra VIVA → LIMITE_DIARIO
  BEGIN
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
    VALUES (v_tenant, v_recurso, v_socio, v_s2, v_s2 + interval '1 hour', 60, 'TEST-MUL-2', 'confirmada');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'LIMITE_DIARIO%' THEN v_ok1 := true; ELSE RAISE; END IF;
  END;

  -- La 1ra pasa a no_show + prender Modelo A (se revierte con el sentinel)
  UPDATE reservas SET status='no_show' WHERE id = v_r1;
  UPDATE tenants SET config =
    COALESCE(config, '{}'::jsonb) || jsonb_build_object('penalizaciones',
      COALESCE(config->'penalizaciones', '{}'::jsonb) ||
      jsonb_build_object('multa_rereserva_activa', true, 'multa_rereserva_centavos', 7500))
  WHERE id = v_tenant;

  -- (2) Modelo A on, sin aceptar → MULTA_REQUERIDA
  PERFORM set_config('sala.acepta_multa', 'off', true);
  BEGIN
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
    VALUES (v_tenant, v_recurso, v_socio, v_s2, v_s2 + interval '1 hour', 60, 'TEST-MUL-3', 'confirmada');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'MULTA_REQUERIDA%' THEN v_ok2 := true; ELSE RAISE; END IF;
  END;

  -- (3) Modelo A on, aceptada → permite y estampa 7500
  PERFORM set_config('sala.acepta_multa', 'on', true);
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
  VALUES (v_tenant, v_recurso, v_socio, v_s3, v_s3 + interval '1 hour', 60, 'TEST-MUL-4', 'confirmada')
  RETURNING multa_centavos INTO v_multa;
  v_ok3 := (v_multa = 7500);

  IF NOT v_ok1 THEN RAISE EXCEPTION 'TEST FALLO: no bloqueó con la 1ra reserva viva.'; END IF;
  IF NOT v_ok2 THEN RAISE EXCEPTION 'TEST FALLO: no pidió MULTA_REQUERIDA con Modelo A activo.'; END IF;
  IF NOT v_ok3 THEN RAISE EXCEPTION 'TEST FALLO: no estampó la multa (multa_centavos=%).', v_multa; END IF;

  RAISE EXCEPTION 'ROLLBACK_MULTA_OK';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_MULTA_OK' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT
  'multa re-reserva (Modelo A)' AS prueba,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='reservas' AND column_name='multa_centavos') AS col_centavos_ok,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='reservas' AND column_name='multa_pagada') AS col_pagada_ok,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='reservas' AND column_name='multa_pago_id') AS col_pago_id_ok,
  (SELECT count(*) FROM information_schema.triggers
   WHERE event_object_table='reservas' AND trigger_name='reservas_limite_diario') AS trigger_esperado_1;