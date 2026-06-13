-- ============================================================================
-- FIX M1 — cancelar reserva desde el admin estaba ROTO (CHECK violation).
-- ----------------------------------------------------------------------------
-- El frontend cancela escribiendo status='cancelada_admin' (crudHelpers.
-- cancelarReserva y MiembroProximasReservas), pero el CHECK de `reservas` solo
-- permitía confirmada/cancelada/completada/no_show → el UPDATE fallaba SIEMPRE.
-- El trigger de lista_espera (dispara en confirmada→cancelada/cancelada_admin) y
-- Reportes ya asumen 'cancelada_admin', confirmando que es el valor intencional.
-- Lo agregamos al CHECK (idempotente). Mismo patrón que el 'revocado' del fix #2.
--
-- NOTA (no es parte de este fix): la cancelación admin hace un UPDATE directo
-- (no pasa por cancelar_reserva_atomic) → libera el cupo y dispara la promoción
-- de lista de espera vía trigger, pero NO devuelve el crédito del socio. Si la
-- política es devolverlo, hace falta un paso aparte (decisión de producto).
-- ============================================================================

ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_status_check;
ALTER TABLE reservas ADD CONSTRAINT reservas_status_check
  CHECK (status IN ('confirmada', 'cancelada', 'completada', 'no_show', 'cancelada_admin'));

-- ============================================================================
-- TEST — el CHECK ahora admite 'cancelada_admin'.
-- ============================================================================
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint WHERE conname = 'reservas_status_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'TEST FALLO: no existe la constraint reservas_status_check.';
  END IF;
  IF position('cancelada_admin' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: el CHECK no incluye cancelada_admin (def=%).', v_def;
  END IF;
  RAISE NOTICE 'TEST OK: reservas_status_check admite cancelada_admin. Cancelar desde admin ya no falla.';
END $$;
