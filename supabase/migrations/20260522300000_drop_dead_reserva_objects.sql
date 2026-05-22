-- ============================================================================
-- Deuda técnica — eliminar objetos muertos del modelo de reservas viejo
-- ============================================================================
-- Dos vestigios del esquema de reservas pre-S4.2 (antes de la tabla `clases`):
--
--   1. reservar_recurso_atomic(uuid, timestamptz, integer, integer, text)
--      El RPC de reserva viejo (por recurso+slot). Reemplazado por
--      reservar_clase_atomic en S4.2. La migración 20260519200000 ya dejó
--      anotado: "drop reservar_recurso_atomic tras un periodo de gracia".
--      Confirmado muerto: el front no lo invoca (solo lo nombran 2 comentarios
--      viejos en reservaLogic.ts, que se corrigen en el front) y ninguna otra
--      función/trigger SQL lo llama.
--
--   2. reservas_folio_seq
--      Secuencia creada en 20260514100500. La usaba (nextval) solo la versión
--      original de reservar_recurso_atomic; las funciones actuales de folio
--      (reservar_clase_atomic, _promover_entrada) usan count-based, no la
--      secuencia. Cero usuarios.
--
-- DROP ... IF EXISTS → idempotente. No toca datos.
-- ============================================================================

DROP FUNCTION IF EXISTS reservar_recurso_atomic(uuid, timestamptz, integer, integer, text);

DROP SEQUENCE IF EXISTS reservas_folio_seq;

DO $$
BEGIN
  RAISE NOTICE 'Objetos muertos eliminados: reservar_recurso_atomic + reservas_folio_seq.';
END $$;
