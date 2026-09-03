-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Cancelar una reserva BORRA su multa pendiente (no se paga por una clase que no tomas)
-- ----------------------------------------------------------------------------
-- Caso Yailed (numa): canceló su clase de las 19:00 tarde (le quemó el día), reservó
-- la de las 20:00 (→ multa $75 por re-reservar tras cancelar tarde) y 17 min después
-- canceló TAMBIÉN la de las 20:00. No asistió a ninguna ese día, pero le quedó la
-- multa en la reserva cancelada.
--
-- La multa (Modelo A) se pone al RESERVAR, para cobrarse si el socio TOMA esa clase
-- extra. Si la cancela, no tomó ninguna clase extra → no hay nada que cobrar. FIX: un
-- trigger BEFORE UPDATE en reservas que, al pasar la reserva a 'cancelada%', pone
-- multa_centavos=0 SI la multa aún NO se ha pagado. Si ya se pagó (multa_pagada=true),
-- se conserva (el dinero ya está en el ledger; devolverlo es decisión aparte). Cubre
-- todas las vías de cancelación (socio, recepción, admin) en un solo lugar.
--
-- No toca las multas de Modelo B (faltar): esas viven en reservas 'no_show', no
-- 'cancelada', así que este trigger no las borra.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_cancelar_borra_multa()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status LIKE 'cancelada%'
     AND OLD.status NOT LIKE 'cancelada%'
     AND COALESCE(NEW.multa_centavos, 0) > 0
     AND NOT COALESCE(NEW.multa_pagada, false) THEN
    NEW.multa_centavos := 0;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cancelar_borra_multa ON reservas;
CREATE TRIGGER cancelar_borra_multa
  BEFORE UPDATE ON reservas
  FOR EACH ROW EXECUTE FUNCTION trg_cancelar_borra_multa();


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) Reserva con multa SIN pagar → al cancelar, la multa se borra (=0).
--   2) Reserva con multa YA pagada → al cancelar, la multa se conserva.
-- Todo dentro de un sub-bloque que se revierte.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_cancelar_borra_multa()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_socio uuid; v_recurso uuid;
  v_r1 uuid; v_r2 uuid; v_m1 int; v_m2 int;
  v_slug text := 'zz-test-clm-' || substr(md5(random()::text), 1, 6);
BEGIN
  BEGIN
    SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
    SELECT id INTO v_recurso FROM recursos WHERE tenant_id=v_tenant LIMIT 1;
    INSERT INTO usuarios (tenant_id,email,nombre,rol,status)
    VALUES (v_tenant, v_slug||'@x.dev','Clm Test','miembro','activo') RETURNING id INTO v_socio;

    -- R1: multa SIN pagar → cancelar la borra.
    INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status,multa_centavos,multa_pagada)
    VALUES (v_tenant,v_recurso,v_socio, now()+interval '2 days', now()+interval '2 days'+interval '1 hour',60,'TEST-CLM-1','confirmada',7500,false)
    RETURNING id INTO v_r1;
    UPDATE reservas SET status='cancelada', cancelada_at=now() WHERE id=v_r1;
    SELECT multa_centavos INTO v_m1 FROM reservas WHERE id=v_r1;

    -- R2: multa YA pagada → cancelar la conserva.
    INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status,multa_centavos,multa_pagada)
    VALUES (v_tenant,v_recurso,v_socio, now()+interval '3 days', now()+interval '3 days'+interval '1 hour',60,'TEST-CLM-2','confirmada',7500,true)
    RETURNING id INTO v_r2;
    UPDATE reservas SET status='cancelada', cancelada_at=now() WHERE id=v_r2;
    SELECT multa_centavos INTO v_m2 FROM reservas WHERE id=v_r2;

    RAISE EXCEPTION 'ROLLBACK_CLM';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_CLM' THEN
      prueba := 'montaje'; resultado := '❌ falló: ' || SQLERRM; RETURN NEXT; RETURN;
    END IF;
  END;

  prueba := '1. cancelar reserva con multa SIN pagar → se borra';
  resultado := CASE WHEN v_m1 = 0 THEN '✅ multa borrada' ELSE '❌ quedó ' || COALESCE(v_m1::text,'NULL') END; RETURN NEXT;
  prueba := '2. cancelar reserva con multa YA pagada → se conserva';
  resultado := CASE WHEN v_m2 = 7500 THEN '✅ multa conservada' ELSE '❌ quedó ' || COALESCE(v_m2::text,'NULL') END; RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_cancelar_borra_multa();
DROP FUNCTION _diag_cancelar_borra_multa();
