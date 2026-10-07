-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Clase de prueba gratis: tampoco se puede RE-comprar (hueco del trigger)
-- ----------------------------------------------------------------------------
-- 20260819250000 puso "1 prueba por socio" con un trigger BEFORE INSERT. Pero
-- recomprar el mismo tier NO inserta: activar_suscripcion_socio /
-- gestionar_membresia_socio hacen UPDATE de la misma fila (+clases_incluidas,
-- reinicia el periodo). En la app, la tarjeta del plan actual tiene "Comprar
-- otro paquete" → recompra el tier actual → al ser $0 se activa sin cobro.
-- Caso real (The Core, 28-sep): Dana Rios la "compró" 5 veces → 4 clases gratis;
-- 9 socias en total con clases de más.
--
-- Arreglo: el trigger también corre en UPDATE cuando cambia tier_id o
-- periodo_actual_inicio. Solo las dos RPCs de activación escriben
-- periodo_actual_inicio (y siempre lo reinician a now()), así que un débito de
-- reserva, congelar o un cambio de status NO disparan la regla.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_una_prueba_por_socio()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_es_prueba boolean; v_n int;
BEGIN
  -- UPDATE que no es una (re)activación: nada que revisar.
  IF TG_OP = 'UPDATE'
     AND NEW.tier_id IS NOT DISTINCT FROM OLD.tier_id
     AND NEW.periodo_actual_inicio IS NOT DISTINCT FROM OLD.periodo_actual_inicio THEN
    RETURN NEW;
  END IF;

  SELECT es_prueba INTO v_es_prueba FROM tiers WHERE id = NEW.tier_id;
  IF COALESCE(v_es_prueba, false) THEN
    INSERT INTO pruebas_usadas (usuario_id, tenant_id, tier_id)
    VALUES (NEW.usuario_id, NEW.tenant_id, NEW.tier_id)
    ON CONFLICT (usuario_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      RAISE EXCEPTION 'PRUEBA_YA_USADA: este socio ya usó su clase de prueba gratis';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS una_prueba_por_socio ON membresias;
CREATE TRIGGER una_prueba_por_socio
  BEFORE INSERT OR UPDATE OF tier_id, periodo_actual_inicio ON membresias
  FOR EACH ROW EXECUTE FUNCTION trg_una_prueba_por_socio();

-- Backfill: quien ya tiene (o tuvo) la prueba y no quedó registrado — p.ej. la
-- tomó por UPDATE (tenía otro plan antes) — queda marcado. Sin esto, su próxima
-- recompra "reclamaría" la prueba por primera vez y pasaría.
INSERT INTO pruebas_usadas (usuario_id, tenant_id, tier_id, created_at)
SELECT DISTINCT ON (m.usuario_id) m.usuario_id, m.tenant_id, t.id, mm.created_at
FROM membresia_movimientos mm
JOIN membresias m ON m.id = mm.membresia_id
JOIN tiers t ON t.tenant_id = m.tenant_id AND t.es_prueba
WHERE mm.tipo = 'alta'
  AND mm.motivo LIKE '% ' || t.slug  -- 'compra de paquete <slug>' / 'alta — tier <slug>'
ORDER BY m.usuario_id, mm.created_at
ON CONFLICT (usuario_id) DO NOTHING;

INSERT INTO pruebas_usadas (usuario_id, tenant_id, tier_id)
SELECT m.usuario_id, m.tenant_id, m.tier_id
FROM membresias m JOIN tiers t ON t.id = m.tier_id
WHERE t.es_prueba
ON CONFLICT (usuario_id) DO NOTHING;

-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA (todo dentro de un bloque que se revierte).
--   1) alta de la prueba → OK.
--   2) débito de reserva (UPDATE créditos) → OK.
--   3) recompra (UPDATE periodo_actual_inicio) → bloquea.
--   4) cambio a la prueba desde otro plan, 1ra vez → OK.
--   5) cambio de la prueba a un plan pagado → OK.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_prueba_recompra()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_prueba uuid; v_pago uuid; v_a uuid; v_b uuid; v_ma uuid; v_mb uuid; v_r text;
  v_slug text := 'zz-test-recompra-' || substr(md5(random()::text),1,6);
  r1 text; r2 text; r3 text; r4 text; r5 text;
BEGIN
  BEGIN
    INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'T','gym_libre','activo') RETURNING id INTO v_tenant;
    INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, es_prueba, activo, orden)
    VALUES (v_tenant,'clase-prueba','Prueba',0,'MXN','mensual','hibrido',1,7,true,true,1) RETURNING id INTO v_prueba;
    INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, activo, orden)
    VALUES (v_tenant,'paquete-8','Paquete 8',80000,'MXN','mensual','creditos',8,30,true,2) RETURNING id INTO v_pago;
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-a@x.dev','A','miembro','activo') RETURNING id INTO v_a;
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-b@x.dev','B','miembro','activo') RETURNING id INTO v_b;

    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,creditos_restantes)
    VALUES (v_tenant,v_a,v_prueba,'activa',now() - interval '1 hour',now()+interval '7 days',1) RETURNING id INTO v_ma;
    r1 := '✅ alta de la prueba: OK';

    UPDATE membresias SET creditos_restantes = 0 WHERE id = v_ma;
    r2 := '✅ débito de reserva: OK';

    BEGIN
      UPDATE membresias SET tier_id = v_prueba, periodo_actual_inicio = now(), creditos_restantes = 1 WHERE id = v_ma;
      r3 := '❌ dejó recomprar la prueba';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_r = MESSAGE_TEXT;
      r3 := CASE WHEN v_r LIKE 'PRUEBA_YA_USADA%' THEN '✅ bloqueó la recompra' ELSE '⚠ otro: '||v_r END;
    END;

    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,creditos_restantes)
    VALUES (v_tenant,v_b,v_pago,'activa',now() - interval '1 hour',now()+interval '30 days',8) RETURNING id INTO v_mb;
    UPDATE membresias SET tier_id = v_prueba, periodo_actual_inicio = now(), creditos_restantes = 1 WHERE id = v_mb;
    r4 := '✅ 1ra prueba de B viniendo de otro plan: OK';

    UPDATE membresias SET tier_id = v_pago, periodo_actual_inicio = now() + interval '1 second', creditos_restantes = 8 WHERE id = v_ma;
    r5 := '✅ de prueba a plan pagado: OK';

    RAISE EXCEPTION 'ROLLBACK_PRUEBA';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_PRUEBA' THEN
      prueba:='montaje'; resultado:='❌ '||SQLERRM; RETURN NEXT; RETURN;
    END IF;
  END;
  prueba:='1. alta de la prueba';                 resultado:=r1; RETURN NEXT;
  prueba:='2. débito de reserva no dispara';      resultado:=r2; RETURN NEXT;
  prueba:='3. recompra de la prueba → bloquea';   resultado:=r3; RETURN NEXT;
  prueba:='4. prueba desde otro plan (1ra vez)';  resultado:=r4; RETURN NEXT;
  prueba:='5. de prueba a plan pagado';           resultado:=r5; RETURN NEXT;
  RETURN;
END $$;
SELECT * FROM _diag_prueba_recompra();
DROP FUNCTION _diag_prueba_recompra();
