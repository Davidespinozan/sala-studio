-- ============================================================================
-- CORRECCIÓN DE DATO — Betsaida Beltrán (The Core, 23-oct-2026)
-- ============================================================================
-- Correr DESPUÉS de la migración 20261023120000_reserva_sigue_al_plan_vigente.
-- Transaccional: si algo no cuadra con lo que se diagnosticó, no persiste nada.
--
-- Situación: la reserva SAL-000272 (POLE FITNESS 23-oct 08:30, completada) cuelga
-- de la membresía de Clase prueba 003d2033 (cancelada sin pagar). La clase la
-- tomó con el Paquete 12 (membresía a7cc6aeb, hoy 12/12). Esto la re-cuelga del
-- Paquete 12 y debita 1 clase ahí (12 → 11), usando el mismo helper que ahora
-- corre en los check-ins. Actor del movimiento: NULL (corrección del sistema).
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_reserva uuid := 'f049837d-8020-42db-96a0-e42b5cf014b3';  -- SAL-000272
  v_prueba  uuid := '003d2033-9c57-44ec-b028-cd79001f918a';  -- Clase prueba (cancelada)
  v_paq12   uuid := 'a7cc6aeb-71b4-4111-9d45-2da508d056ad';  -- Paquete 12 (activa)
  v_mem uuid;
  v_status text;
  v_saldo integer;
  v_res jsonb;
BEGIN
  SELECT membresia_id, status INTO v_mem, v_status FROM reservas WHERE id = v_reserva FOR UPDATE;
  IF v_mem IS DISTINCT FROM v_prueba THEN
    RAISE EXCEPTION 'La reserva ya no cuelga de la prueba (membresia_id=%). Nada que corregir.', v_mem;
  END IF;
  IF v_status <> 'completada' THEN
    RAISE EXCEPTION 'La reserva no está completada (status=%). Revisar antes de corregir.', v_status;
  END IF;
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_paq12 AND status = 'activa';
  IF v_saldo IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'El Paquete 12 no está en 12/12 activo (saldo=%). Revisar antes de corregir.', v_saldo;
  END IF;

  v_res := _reserva_trasladar_a_plan_vigente(v_reserva, NULL);
  IF COALESCE((v_res->>'trasladada')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'No se trasladó: %', v_res;
  END IF;
  IF (v_res->>'a_membresia_id')::uuid <> v_paq12 OR (v_res->>'creditos')::integer <> 1 THEN
    RAISE EXCEPTION 'Resultado inesperado: %', v_res;
  END IF;
END $$;

-- Verificación (debe decir: reserva en Paquete 12, saldo 11, débito -1 registrado).
SELECT
  r.folio,
  r.status,
  t.nombre                                   AS plan_de_la_reserva,
  m.creditos_restantes                       AS clases_restantes_paq12,
  (SELECT count(*) FROM membresia_movimientos mm
     WHERE mm.reserva_id = r.id AND mm.membresia_id = m.id AND mm.tipo = 'debito') AS debitos_en_paq12
FROM reservas r
JOIN membresias m ON m.id = r.membresia_id
JOIN tiers t ON t.id = m.tier_id
WHERE r.id = 'f049837d-8020-42db-96a0-e42b5cf014b3';

COMMIT;
