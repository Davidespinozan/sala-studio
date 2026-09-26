-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ════════════════════════════════════════════════════════════════════════════
-- RECEPCIÓN puede ACEPTAR un cobro al reservar (recargo de franja / multa no-show)
-- ----------------------------------------------------------------------------
-- Hoy `recepcion_crear_reserva` (INSERT directo a reservas) NUNCA pone el flag
-- `sala.acepta_multa`, así que los triggers BEFORE INSERT que dependen de él
-- (verificar_franja_acceso_reserva → RECARGO_FRANJA, y verificar_limite_diario_reserva
-- → MULTA_REQUERIDA) bloquean el walk-in sin forma de aceptarlo desde mostrador.
--
-- Este wrapper es el gemelo de reservar_clase_atomic_con_multa (flujo del socio,
-- 20260806180000): pone el flag y delega en recepcion_crear_reserva. Con eso los DOS
-- triggers estampan su cobro en reservas.multa_centavos y recepción lo cobra con la
-- UI de multas pendientes que ya existe. No cambia recepcion_crear_reserva.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION recepcion_crear_reserva_con_multa(
  p_usuario_id uuid,
  p_clase_id   uuid DEFAULT NULL,
  p_horario_id uuid DEFAULT NULL,
  p_fecha      date DEFAULT NULL,
  p_invitados  integer DEFAULT 0,
  p_notas      text DEFAULT NULL,
  p_lugar_id   text DEFAULT NULL,
  p_motivo     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res jsonb;
  v_multa int;
BEGIN
  -- Recepción aceptó el cobro: los triggers de franja/no-show lo estampan en vez de bloquear.
  PERFORM set_config('sala.acepta_multa', 'on', true);
  v_res := recepcion_crear_reserva(
    p_usuario_id, p_clase_id, p_horario_id, p_fecha,
    p_invitados, p_notas, p_lugar_id, p_motivo
  );
  SELECT multa_centavos INTO v_multa FROM reservas WHERE id = (v_res->>'reserva_id')::uuid;
  RETURN v_res || jsonb_build_object('multa_centavos', COALESCE(v_multa, 0));
END; $$;

REVOKE ALL ON FUNCTION recepcion_crear_reserva_con_multa(uuid, uuid, uuid, date, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recepcion_crear_reserva_con_multa(uuid, uuid, uuid, date, integer, text, text, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA: verifica que el wrapper existe con la firma esperada y que
-- authenticated puede ejecutarlo. (El flujo con JWT/roles se prueba en la app.)
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'recepcion_crear_reserva_con_multa' AS prueba,
  EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'recepcion_crear_reserva_con_multa'
  ) AS existe_ok,
  has_function_privilege('authenticated',
    'recepcion_crear_reserva_con_multa(uuid, uuid, uuid, date, integer, text, text, text)', 'EXECUTE') AS grant_ok,
  NOT has_function_privilege('anon',
    'recepcion_crear_reserva_con_multa(uuid, uuid, uuid, date, integer, text, text, text)', 'EXECUTE') AS anon_revocado_ok;
