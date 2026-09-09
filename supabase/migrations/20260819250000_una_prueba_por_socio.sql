-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Clase de prueba gratis: 1 por socio de por vida
-- ----------------------------------------------------------------------------
-- The Core Studio ofrece "clase de prueba gratis" (un tier en $0). Antes nada impedía
-- dársela a un mismo socio varias veces. Ahora: un flag `tiers.es_prueba` (por-tenant,
-- editable) + un registro DURABLE por socio.
--
-- Por qué durable (tabla `pruebas_usadas`) y no mirar membresías: al asignarle luego un
-- plan real, gestionar_membresia_socio REESCRIBE la misma fila de membresía → se
-- perdería el rastro de que ya tomó su prueba. La tabla lo marca la primera vez y el PK
-- por usuario bloquea la segunda (race-safe con ON CONFLICT). El trigger en `membresias`
-- cubre TODAS las vías (recepción, autoservicio, SQL). Aplica de aquí en adelante.
-- ============================================================================

ALTER TABLE tiers ADD COLUMN IF NOT EXISTS es_prueba boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tiers.es_prueba IS
  'true = clase/plan de PRUEBA gratis, 1 por socio de por vida (trigger una_prueba_por_socio + tabla pruebas_usadas).';

CREATE TABLE IF NOT EXISTS pruebas_usadas (
  usuario_id uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tier_id    uuid REFERENCES tiers(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pruebas_usadas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pruebas_usadas_staff ON pruebas_usadas;
CREATE POLICY pruebas_usadas_staff ON pruebas_usadas FOR SELECT TO authenticated
  USING (is_recepcionista() AND tenant_id = get_my_tenant_id());
-- Escritura solo por el trigger (SECURITY DEFINER); sin policies de INSERT/UPDATE.

CREATE OR REPLACE FUNCTION trg_una_prueba_por_socio()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_es_prueba boolean; v_n int;
BEGIN
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
  BEFORE INSERT ON membresias
  FOR EACH ROW EXECUTE FUNCTION trg_una_prueba_por_socio();

-- (El marcado del tier clase-prueba de The Core Studio como es_prueba=true se corrió
--  aparte como dato del tenant; no va en la migración genérica.)

-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) primera prueba de un socio → OK.
--   2) segunda prueba al MISMO socio → bloquea (PRUEBA_YA_USADA).
--   3) prueba a OTRO socio → OK.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_una_prueba()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_tier uuid; v_a uuid; v_b uuid; v_r text;
  v_slug text := 'zz-test-prueba-' || substr(md5(random()::text),1,6);
  v_ok1 text; v_ok2 text; v_ok3 text;
BEGIN
  BEGIN
    INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'T','gym_libre','activo') RETURNING id INTO v_tenant;
    INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, es_pase, es_prueba, activo, orden)
    VALUES (v_tenant,'clase-prueba','Prueba',0,'MXN','mensual','hibrido',1,7,true,true,true,1) RETURNING id INTO v_tier;
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-a@x.dev','A','miembro','activo') RETURNING id INTO v_a;
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status) VALUES (v_tenant,v_slug||'-b@x.dev','B','miembro','activo') RETURNING id INTO v_b;

    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,creditos_restantes)
    VALUES (v_tenant,v_a,v_tier,'activa',now(),now()+interval '7 days',1);
    v_ok1 := '✅ 1ra prueba de A: OK';

    BEGIN
      INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,creditos_restantes)
      VALUES (v_tenant,v_a,v_tier,'activa',now(),now()+interval '7 days',1);
      v_ok2 := '❌ dejó una 2da prueba a A';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_r = MESSAGE_TEXT;
      v_ok2 := CASE WHEN v_r LIKE 'PRUEBA_YA_USADA%' THEN '✅ bloqueó la 2da de A' ELSE '⚠ otro: '||v_r END;
    END;

    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin,creditos_restantes)
    VALUES (v_tenant,v_b,v_tier,'activa',now(),now()+interval '7 days',1);
    v_ok3 := '✅ prueba de B (otro socio): OK';

    RAISE EXCEPTION 'ROLLBACK_PRUEBA';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_PRUEBA' THEN
      prueba:='montaje'; resultado:='❌ '||SQLERRM; RETURN NEXT; RETURN;
    END IF;
  END;
  prueba:='1. primera prueba por socio'; resultado:=v_ok1; RETURN NEXT;
  prueba:='2. segunda prueba al mismo → bloquea'; resultado:=v_ok2; RETURN NEXT;
  prueba:='3. prueba a otro socio → OK'; resultado:=v_ok3; RETURN NEXT;
  RETURN;
END $$;
SELECT * FROM _diag_una_prueba();
DROP FUNCTION _diag_una_prueba();
