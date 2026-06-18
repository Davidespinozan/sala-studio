-- ============================================================================
-- MAPA DE SALÓN · Lote 1b — propagar p_lugar_id por la reserva VIRTUAL
-- ----------------------------------------------------------------------------
-- reservar_clase_virtual materializa la clase y delega en reservar_clase_atomic.
-- Como la mayoría de las reservas pasan por la vía virtual, hay que aceptar el
-- lugar y pasarlo. Se reemplaza la firma (4 → 5 args, p_lugar_id DEFAULT NULL):
-- las llamadas actuales por nombre, sin lugar, siguen funcionando.
-- ============================================================================

DROP FUNCTION IF EXISTS reservar_clase_virtual(uuid, date, integer, text);

CREATE OR REPLACE FUNCTION reservar_clase_virtual(
  p_horario_id uuid,
  p_fecha date,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clase_id uuid;
BEGIN
  v_clase_id := materializar_clase(p_horario_id, p_fecha);
  RETURN reservar_clase_atomic(v_clase_id, p_invitados, p_notas, p_lugar_id);
END $$;

REVOKE ALL ON FUNCTION reservar_clase_virtual(uuid, date, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reservar_clase_virtual(uuid, date, integer, text, text) TO authenticated;
