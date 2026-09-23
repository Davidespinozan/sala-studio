-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Append-only de pagos: proteger también la columna `referencia` (defensa en prof.)
-- ----------------------------------------------------------------------------
-- corregir_metodo_pago() solo debe cambiar `metodo` y `notas`; el trigger valida que
-- todo lo demás quede idéntico. Faltaba `referencia` en esa lista blanca — es la
-- llave de idempotencia (Stripe/folio). NO es explotable hoy (el único que prende el
-- flag sala.corrige_metodo es ese RPC SECURITY DEFINER, que solo toca metodo+notas, y
-- un authenticated no puede fijar el GUC vía PostgREST), pero conviene blindarlo.
-- Solo se re-crea el trigger agregando la validación de `referencia`; lo demás igual.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_pagos_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- DELETE: solo dentro de cerrar_tenant() (que prende sala.cierre_tenant).
  IF TG_OP = 'DELETE'
     AND current_setting('sala.cierre_tenant', true) = 'on' THEN
    RETURN OLD;
  END IF;

  -- UPDATE: solo para CORREGIR EL MÉTODO (no mueve dinero), dentro de
  -- corregir_metodo_pago() (que prende sala.corrige_metodo). Todo lo demás del
  -- pago debe quedar idéntico; solo pueden cambiar `metodo` y `notas`.
  IF TG_OP = 'UPDATE'
     AND current_setting('sala.corrige_metodo', true) = 'on'
     AND NEW.metodo IN ('efectivo', 'tarjeta', 'transferencia')
     AND NEW.monto_centavos   IS NOT DISTINCT FROM OLD.monto_centavos
     AND NEW.moneda           IS NOT DISTINCT FROM OLD.moneda
     AND NEW.concepto         IS NOT DISTINCT FROM OLD.concepto
     AND NEW.usuario_id       IS NOT DISTINCT FROM OLD.usuario_id
     AND NEW.tenant_id        IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.tier_id          IS NOT DISTINCT FROM OLD.tier_id
     AND NEW.membresia_id     IS NOT DISTINCT FROM OLD.membresia_id
     AND NEW.sucursal_id      IS NOT DISTINCT FROM OLD.sucursal_id
     AND NEW.cobrado_por      IS NOT DISTINCT FROM OLD.cobrado_por
     AND NEW.created_at       IS NOT DISTINCT FROM OLD.created_at
     AND NEW.revierte_pago_id IS NOT DISTINCT FROM OLD.revierte_pago_id
     AND NEW.referencia       IS NOT DISTINCT FROM OLD.referencia
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'PAGOS_APPEND_ONLY: un pago no se edita ni se borra; registrá un asiento de corrección';
END;
$$;

-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA: el trigger ahora exige que `referencia` quede igual.
-- ============================================================================
SELECT
  'append-only protege referencia' AS prueba,
  pg_get_functiondef('trg_pagos_append_only()'::regprocedure)
    ILIKE '%NEW.referencia%IS NOT DISTINCT FROM%OLD.referencia%' AS protege_referencia;
