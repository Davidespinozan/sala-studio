-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- HOTFIX: el trigger "el pase sigue a su clase" usaba el flag EQUIVOCADO.
-- ────────────────────────────────────────────────────────────────────────────
-- 20260811120000 ancló la vigencia de los pases a su clase reservada filtrando
-- por tiers.pago_unico. Error de semántica: pago_unico significa "NO
-- autorenovable, se paga en mostrador" (los planes mensuales de numa — Ultra,
-- Elevate, $1,400-1,600 — lo tienen en true), y el Day Pass real de numa lo
-- tiene en false. Efecto doble: los day passes NO se extendían, y un socio de
-- Plan Ultra que reservara tras su vencimiento habría recibido días GRATIS.
--
-- Arreglo: flag explícito tiers.es_pase (editable en el admin, nada implícito).
-- El trigger extiende SOLO tiers con es_pase = true.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS es_pase boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tiers.es_pase IS
  'true = pase suelto (Day Pass, semana suelta): su vigencia se extiende hasta el fin del día de la clase reservada (trigger pase_sigue_a_reserva). false = plan normal: reservar no mueve su vencimiento.';

-- ── El trigger ahora filtra por es_pase (antes: pago_unico, equivocado) ─────
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

  v_fin_dia := (((NEW.slot_inicio AT TIME ZONE v_tz)::date + 1)::text || ' 00:00:00')::timestamp
               AT TIME ZONE v_tz;

  UPDATE membresias m
  SET periodo_actual_fin = v_fin_dia, updated_at = now()
  FROM tiers ti
  WHERE ti.id = m.tier_id
    AND m.usuario_id = NEW.usuario_id
    AND m.tenant_id  = NEW.tenant_id
    AND m.status IN ('activa', 'trialing', 'past_due')
    AND ti.es_pase                          -- SOLO pases sueltos, explícito
    AND m.periodo_actual_fin IS NOT NULL
    AND m.periodo_actual_fin < v_fin_dia;   -- solo extiende, jamás acorta

  RETURN NEW;
END;
$$;

-- ── Marcar el pase real de numa ─────────────────────────────────────────────
UPDATE tiers t
SET es_pase = true
FROM tenants tn
WHERE tn.id = t.tenant_id
  AND tn.slug = 'numawellness'
  AND t.slug = 'daypass';

-- ── Backfill: pases vivos con reserva futura más allá de su vigencia ────────
WITH candidatos AS (
  SELECT
    m.id AS membresia_id,
    max(
      (((r.slot_inicio AT TIME ZONE COALESCE(tn.config->>'timezone', 'America/Mexico_City'))::date + 1)::text
        || ' 00:00:00')::timestamp
      AT TIME ZONE COALESCE(tn.config->>'timezone', 'America/Mexico_City')
    ) AS nuevo_fin
  FROM membresias m
  JOIN tiers   ti ON ti.id = m.tier_id AND ti.es_pase
  JOIN tenants tn ON tn.id = m.tenant_id
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
-- SELF-TEST — (1) tier es_pase ⇒ se extiende. (2) tier pago_unico=true pero
-- es_pase=false (el caso Plan Ultra) ⇒ NO se toca. Se auto-verifica y revierte.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_socio2 uuid; v_recurso uuid; v_sucursal uuid;
  v_tier_pase uuid; v_tier_plan uuid;
  v_mem_pase uuid; v_mem_plan uuid;
  v_fin_antes timestamptz; v_fin_despues timestamptz; v_fin_plan timestamptz;
  v_slug text := 'zz-test-espase-' || substr(md5(random()::text), 1, 6);
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test es_pase', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-a@sala.dev', 'Socia Pase', 'miembro', 'activo') RETURNING id INTO v_socio;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-b@sala.dev', 'Socio Ultra', 'miembro', 'activo') RETURNING id INTO v_socio2;

  -- Pase real (es_pase) y plan mensual de mostrador (pago_unico=true, es_pase=false).
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, es_pase, pago_unico, duracion_dias)
  VALUES (v_tenant, 'daypass-test', 'Day Pass Test', 15000, true, false, 7) RETURNING id INTO v_tier_pase;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, es_pase, pago_unico, duracion_dias)
  VALUES (v_tenant, 'ultra-test', 'Ultra Test', 160000, false, true, 30) RETURNING id INTO v_tier_plan;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier_pase, 'activa', now() + interval '1 day') RETURNING id INTO v_mem_pase;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_fin)
  VALUES (v_tenant, v_socio2, v_tier_plan, 'activa', now() + interval '2 days') RETURNING id INTO v_mem_plan;

  SELECT id INTO v_sucursal FROM sucursales WHERE tenant_id = v_tenant LIMIT 1;
  IF v_sucursal IS NULL THEN
    INSERT INTO sucursales (tenant_id, nombre) VALUES (v_tenant, 'Sede Test') RETURNING id INTO v_sucursal;
  END IF;
  INSERT INTO recursos (tenant_id, sucursal_id, slug, nombre)
  VALUES (v_tenant, v_sucursal, 'sala-test', 'Sala Test') RETURNING id INTO v_recurso;

  -- 1) Pase reserva a 3 días ⇒ se extiende.
  SELECT periodo_actual_fin INTO v_fin_antes FROM membresias WHERE id = v_mem_pase;
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio)
  VALUES (v_tenant, v_recurso, v_socio, now() + interval '3 days', now() + interval '3 days 1 hour', 60, 'TST-000001');
  SELECT periodo_actual_fin INTO v_fin_despues FROM membresias WHERE id = v_mem_pase;
  IF v_fin_despues <= v_fin_antes THEN
    RAISE EXCEPTION 'TEST FALLO: el pase es_pase no se extendió (antes %, después %)', v_fin_antes, v_fin_despues;
  END IF;

  -- 2) Plan pago_unico (NO es_pase) reserva a 5 días ⇒ NO se extiende (el bug que
  --    habría regalado días de Plan Ultra).
  SELECT periodo_actual_fin INTO v_fin_antes FROM membresias WHERE id = v_mem_plan;
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio)
  VALUES (v_tenant, v_recurso, v_socio2, now() + interval '5 days', now() + interval '5 days 1 hour', 60, 'TST-000002');
  SELECT periodo_actual_fin INTO v_fin_plan FROM membresias WHERE id = v_mem_plan;
  IF v_fin_plan <> v_fin_antes THEN
    RAISE EXCEPTION 'TEST FALLO: un plan pago_unico SIN es_pase se extendió (antes %, después %)', v_fin_antes, v_fin_plan;
  END IF;

  RAISE EXCEPTION 'ROLLBACK_OK_ESPASE';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_OK_ESPASE' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

-- Verificación final (devuelve tabla).
SELECT
  'es_pase: trigger corregido y daypass de numa marcado'                  AS prueba,
  (SELECT pg_get_functiondef(oid) LIKE '%es_pase%'
     FROM pg_proc WHERE proname = 'trg_pase_sigue_a_reserva')             AS trigger_usa_es_pase,
  (SELECT count(*) FROM tiers t JOIN tenants tn ON tn.id = t.tenant_id
    WHERE tn.slug = 'numawellness' AND t.es_pase)                         AS pases_numa_marcados,
  (SELECT count(*) FROM membresias m
     JOIN tiers ti ON ti.id = m.tier_id AND ti.es_pase
     JOIN reservas r ON r.usuario_id = m.usuario_id AND r.status = 'confirmada' AND r.slot_inicio > now()
    WHERE m.status IN ('activa','trialing','past_due')
      AND m.periodo_actual_fin < r.slot_inicio)                           AS pases_aun_cortos_debe_ser_0;
