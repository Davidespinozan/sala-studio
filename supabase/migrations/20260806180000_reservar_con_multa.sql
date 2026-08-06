-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- RESERVAR ACEPTANDO LA MULTA (Modelo A) — pieza 2 (RPC)
-- ────────────────────────────────────────────────────────────────────────────
-- El trigger del tope diario (migración anterior) lanza MULTA_REQUERIDA cuando el
-- socio topó su cupo SOLO por un no_show y el Modelo A está activo. La app muestra
-- el modal "reservarás asumiendo una multa de $X" y, si acepta, reintenta con estos
-- wrappers, que ponen el flag por transacción `sala.acepta_multa=on` y delegan en
-- el RPC de siempre. Así NO tocamos la función grande de reservar.
--
-- Devuelven lo mismo que el RPC base + `multa_centavos` (lo que estampó el trigger),
-- para que la app confirme al socio cuánto asumió.
--
-- Hay dos porque el front usa dos caminos: clase ya materializada (por clase_id) y
-- clase virtual (por horario+fecha). Ambos terminan en reservar_clase_atomic.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Clase materializada ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reservar_clase_atomic_con_multa(
  p_clase_id uuid,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL
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
  PERFORM set_config('sala.acepta_multa', 'on', true); -- transacción actual
  v_res := reservar_clase_atomic(p_clase_id, p_invitados, p_notas, p_lugar_id);
  SELECT multa_centavos INTO v_multa FROM reservas WHERE id = (v_res->>'reserva_id')::uuid;
  RETURN v_res || jsonb_build_object('multa_centavos', COALESCE(v_multa, 0));
END; $$;

REVOKE ALL ON FUNCTION reservar_clase_atomic_con_multa(uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reservar_clase_atomic_con_multa(uuid, integer, text, text) TO authenticated;

-- ── Clase virtual (materializa + reserva) ───────────────────────────────────
CREATE OR REPLACE FUNCTION reservar_clase_virtual_con_multa(
  p_horario_id uuid,
  p_fecha date,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL
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
  PERFORM set_config('sala.acepta_multa', 'on', true); -- transacción actual
  v_res := reservar_clase_virtual(p_horario_id, p_fecha, p_invitados, p_notas, p_lugar_id);
  SELECT multa_centavos INTO v_multa FROM reservas WHERE id = (v_res->>'reserva_id')::uuid;
  RETURN v_res || jsonb_build_object('multa_centavos', COALESCE(v_multa, 0));
END; $$;

REVOKE ALL ON FUNCTION reservar_clase_virtual_con_multa(uuid, date, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reservar_clase_virtual_con_multa(uuid, date, integer, text, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA: existen los dos wrappers y authenticated puede ejecutarlos.
-- (El flujo funcional se prueba en la app: necesita el JWT del socio para get_my_user_id.)
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'wrappers reservar-con-multa' AS prueba,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname='reservar_clase_atomic_con_multa')  AS atomic_ok,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname='reservar_clase_virtual_con_multa') AS virtual_ok,
  has_function_privilege('authenticated',
    'reservar_clase_atomic_con_multa(uuid, integer, text, text)', 'EXECUTE')       AS grant_atomic_ok,
  has_function_privilege('authenticated',
    'reservar_clase_virtual_con_multa(uuid, date, integer, text, text)', 'EXECUTE') AS grant_virtual_ok;