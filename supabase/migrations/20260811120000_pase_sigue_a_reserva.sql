-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- EL PASE SIGUE A SU CLASE — vigencia de pases de pago único anclada a la reserva.
-- ────────────────────────────────────────────────────────────────────────────
-- numa vende Day Passes (tier pago_unico, duracion_dias=1) y la clienta reserva
-- su clase para dentro de 3-4 días. El pase vencía al día siguiente de VENDERSE
-- (now() + duracion_dias), así que al llegar el día de su clase: membresía
-- expirada, sin check-in y sin acceso a su app. La intención real de quien
-- compra un day pass y reserva el jueves es "mi pase es para el jueves".
--
-- Regla: cuando un socio con pase de pago único VIGENTE reserva (o se le
-- reagenda) una clase que termina después de su vigencia, el pase se extiende
-- hasta el final del día de esa clase (tz del gym). Nunca se acorta. El
-- limitador real del pase siguen siendo sus créditos (1 clase); la fecha solo
-- acompaña. Cancelar la reserva NO regresa la fecha (puede re-reservar).
--
-- Trigger en `reservas` (no en los RPCs): cubre TODOS los caminos que crean o
-- mueven reservas — app del socio, recepción, admin/agenda.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION trg_pase_sigue_a_reserva()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_fin_dia timestamptz;
BEGIN
  SELECT COALESCE(t.config->>'timezone', 'America/Mexico_City')
  INTO v_tz FROM tenants t WHERE t.id = NEW.tenant_id;

  -- Medianoche SIGUIENTE al día de la clase, en la tz del gym: el pase vale
  -- todo el día de su clase (check-in temprano incluido).
  v_fin_dia := (((NEW.slot_inicio AT TIME ZONE v_tz)::date + 1)::text || ' 00:00:00')::timestamp
               AT TIME ZONE v_tz;

  UPDATE membresias m
  SET periodo_actual_fin = v_fin_dia, updated_at = now()
  FROM tiers ti
  WHERE ti.id = m.tier_id
    AND m.usuario_id = NEW.usuario_id
    AND m.tenant_id  = NEW.tenant_id
    AND m.status IN ('activa', 'trialing', 'past_due')
    AND ti.pago_unico
    AND m.periodo_actual_fin IS NOT NULL
    AND m.periodo_actual_fin < v_fin_dia;   -- solo extiende, jamás acorta

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pase_sigue_a_reserva ON reservas;
CREATE TRIGGER pase_sigue_a_reserva
  AFTER INSERT OR UPDATE OF slot_inicio, status ON reservas
  FOR EACH ROW
  WHEN (NEW.status = 'confirmada')
  EXECUTE FUNCTION trg_pase_sigue_a_reserva();

COMMENT ON FUNCTION trg_pase_sigue_a_reserva() IS
  'Un pase de pago único (Day Pass, etc.) se extiende hasta el fin del día de la '
  'clase reservada: quien compra un pase y reserva el jueves, tiene pase para el '
  'jueves. Solo extiende (nunca acorta) y solo para tiers con pago_unico.';

-- ── Backfill: pases vivos que YA reservaron más allá de su vigencia ─────────
-- (los vendidos esta semana en numa). Mismo cálculo que el trigger.
WITH candidatos AS (
  SELECT
    m.id AS membresia_id,
    max(
      (((r.slot_inicio AT TIME ZONE COALESCE(t.config->>'timezone', 'America/Mexico_City'))::date + 1)::text
        || ' 00:00:00')::timestamp
      AT TIME ZONE COALESCE(t.config->>'timezone', 'America/Mexico_City')
    ) AS nuevo_fin
  FROM membresias m
  JOIN tiers   ti ON ti.id = m.tier_id AND ti.pago_unico
  JOIN tenants t  ON t.id = m.tenant_id
  JOIN reservas r ON r.usuario_id = m.usuario_id
    AND r.tenant_id = m.tenant_id
    AND r.status = 'confirmada'
    AND r.slot_inicio > now()
  WHERE m.status IN ('activa', 'trialing', 'past_due')
    AND m.periodo_actual_fin IS NOT NULL
  GROUP BY m.id
)
UPDATE membresias m
SET periodo_actual_fin = c.nuevo_fin, updated_at = now()
FROM candidatos c
WHERE m.id = c.membresia_id
  AND m.periodo_actual_fin < c.nuevo_fin;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST — pase de 1 día + reserva a 3 días ⇒ el pase se extiende al día de
-- la clase. Un plan NO pago_unico con la misma reserva ⇒ NO se toca. Se
-- auto-verifica y revierte (tenant desechable).
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_socio2 uuid; v_recurso uuid; v_sucursal uuid;
  v_tier_pase uuid; v_tier_plan uuid;
  v_mem_pase uuid; v_mem_plan uuid;
  v_fin_antes timestamptz; v_fin_despues timestamptz; v_fin_plan timestamptz;
  v_slug text := 'zz-test-pase-' || substr(md5(random()::text), 1, 6);
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test pase sigue a reserva', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-a@sala.dev', 'Socia Pase', 'miembro', 'activo') RETURNING id INTO v_socio;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-b@sala.dev', 'Socio Plan', 'miembro', 'activo') RETURNING id INTO v_socio2;

  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, pago_unico, duracion_dias)
  VALUES (v_tenant, 'daypass-test', 'Day Pass Test', 15000, true, 1) RETURNING id INTO v_tier_pase;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, pago_unico, duracion_dias)
  VALUES (v_tenant, 'mensual-test', 'Mensual Test', 80000, false, 30) RETURNING id INTO v_tier_plan;

  -- Pase vigente que vence mañana; plan mensual que vence en 2 días (renovación cerca).
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier_pase, 'activa', now() + interval '1 day') RETURNING id INTO v_mem_pase;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_fin)
  VALUES (v_tenant, v_socio2, v_tier_plan, 'activa', now() + interval '2 days') RETURNING id INTO v_mem_plan;

  -- Multi-sucursal: recursos.sucursal_id es NOT NULL. Usa la sede que el alta
  -- del tenant haya creado o crea una para el test.
  SELECT id INTO v_sucursal FROM sucursales WHERE tenant_id = v_tenant LIMIT 1;
  IF v_sucursal IS NULL THEN
    INSERT INTO sucursales (tenant_id, nombre) VALUES (v_tenant, 'Sede Test') RETURNING id INTO v_sucursal;
  END IF;
  INSERT INTO recursos (tenant_id, sucursal_id, slug, nombre)
  VALUES (v_tenant, v_sucursal, 'sala-test', 'Sala Test') RETURNING id INTO v_recurso;

  SELECT periodo_actual_fin INTO v_fin_antes FROM membresias WHERE id = v_mem_pase;

  -- 1) La socia del PASE reserva a 3 días ⇒ el pase debe extenderse.
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio)
  VALUES (v_tenant, v_recurso, v_socio, now() + interval '3 days', now() + interval '3 days 1 hour', 60, 'TST-000001');

  SELECT periodo_actual_fin INTO v_fin_despues FROM membresias WHERE id = v_mem_pase;
  IF v_fin_despues <= v_fin_antes THEN
    RAISE EXCEPTION 'TEST FALLO: el pase no se extendió (antes %, después %)', v_fin_antes, v_fin_despues;
  END IF;
  IF v_fin_despues < now() + interval '3 days' THEN
    RAISE EXCEPTION 'TEST FALLO: el pase no cubre el día de la clase (fin %)', v_fin_despues;
  END IF;

  -- 2) El socio del PLAN mensual reserva a 5 días ⇒ su fin de periodo NO se toca
  --    (la renovación es asunto del plan, no de la reserva).
  SELECT periodo_actual_fin INTO v_fin_antes FROM membresias WHERE id = v_mem_plan;
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio)
  VALUES (v_tenant, v_recurso, v_socio2, now() + interval '5 days', now() + interval '5 days 1 hour', 60, 'TST-000002');

  SELECT periodo_actual_fin INTO v_fin_plan FROM membresias WHERE id = v_mem_plan;
  IF v_fin_plan <> v_fin_antes THEN
    RAISE EXCEPTION 'TEST FALLO: el plan mensual se extendió y no debía (antes %, después %)', v_fin_antes, v_fin_plan;
  END IF;

  RAISE EXCEPTION 'ROLLBACK_OK_PASE';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_OK_PASE' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

-- Verificación final (devuelve tabla).
SELECT
  'el pase sigue a su clase reservada'                              AS prueba,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pase_sigue_a_reserva') AS trigger_ok,
  (SELECT count(*) FROM membresias m
     JOIN tiers ti ON ti.id = m.tier_id AND ti.pago_unico
     JOIN reservas r ON r.usuario_id = m.usuario_id AND r.status = 'confirmada' AND r.slot_inicio > now()
    WHERE m.status IN ('activa','trialing','past_due')
      AND m.periodo_actual_fin < r.slot_inicio)                     AS pases_aun_cortos_debe_ser_0;
