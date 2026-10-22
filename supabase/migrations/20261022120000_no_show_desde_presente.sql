-- ============================================================================
-- No-show desde "presente" (completada → no_show)
-- ============================================================================
-- Caso real (The Core, 22-oct-2026, Lorena Borrego, clase 8:30):
--   10:30  el cron marcar_no_shows la marcó no_show (crédito quemado, asiento ledger).
--   13:10  admin tocó "Revertir a confirmada" en la agenda → en realidad llama
--          admin_marcar_asistencia y la dejó como PRESENTE (completada).
--   luego  admin quiso "Marcar como no-show" sobre esa fila: la UI ofrece la
--          acción para status 'completada', pero recepcion_marcar_no_show solo
--          aceptaba 'confirmada' → RESERVA_NO_MARCABLE, que la UI tapaba con
--          "No pudimos marcar la inasistencia. Prueba de nuevo."
--
-- Arreglo: el RPC acepta también 'completada' (corrección de un check-in
-- equivocado). Al venir de 'completada' limpia los campos de check-in.
-- Dinero/créditos: sin cambio. El crédito de la reserva ya se debitó al
-- reservar y en no-show se queda quemado igual que desde 'confirmada';
-- _registrar_no_show_ledger es anti-doble por reserva_id.
-- ACL: CREATE OR REPLACE conserva los GRANT/REVOKE existentes
-- (20261007140000_endurecer_acl_anon).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.recepcion_marcar_no_show(p_reserva_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_res RECORD;
  v_desde_presente boolean;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;

  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    p_motivo := 'Marcado como no-show por recepción';
  END IF;

  SELECT r.id, r.status, r.tenant_id, r.usuario_id, r.slot_inicio, r.recurso_id, u.nombre, r.clase_id
  INTO v_res
  FROM reservas r
  LEFT JOIN usuarios u ON u.id = r.usuario_id
  WHERE r.id = p_reserva_id;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;
  IF v_res.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa reserva no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_res.clase_id));

  -- 'confirmada' = no llegó. 'completada' = alguien lo marcó presente por error
  -- y se corrige. Cancelada / ya no_show no se tocan.
  IF v_res.status NOT IN ('confirmada', 'completada') THEN
    RAISE EXCEPTION 'RESERVA_NO_MARCABLE: solo una reserva confirmada o presente se puede marcar como no-show (status actual: %)', v_res.status;
  END IF;
  v_desde_presente := (v_res.status = 'completada');

  -- La asistencia se computa desde reservas.status='no_show'; la columna
  -- contadora deprecada (20260519000000) ya no se toca.
  UPDATE reservas
  SET status = 'no_show',
      check_in_at = CASE WHEN v_desde_presente THEN NULL ELSE check_in_at END,
      check_in_by = CASE WHEN v_desde_presente THEN NULL ELSE check_in_by END,
      check_in_method = CASE WHEN v_desde_presente THEN NULL ELSE check_in_method END,
      updated_at = now()
  WHERE id = p_reserva_id;

  -- Traza en el ledger: el crédito debitado se quema (penalización), delta 0.
  PERFORM _registrar_no_show_ledger(p_reserva_id, get_my_user_id());

  PERFORM _audrec_log(
    'clase.marcar_no_show', 'reserva', p_reserva_id, v_res.usuario_id, v_res.nombre,
    format('Marcó no-show de la reserva del %s%s. Motivo: %s',
           to_char(v_res.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN v_desde_presente THEN ' (corrigió un check-in previo)' ELSE '' END,
           p_motivo),
    jsonb_build_object('slot_inicio', v_res.slot_inicio, 'recurso_id', v_res.recurso_id,
                       'motivo', p_motivo, 'desde_presente', v_desde_presente)
  );

  RETURN jsonb_build_object('success', true, 'status', 'no_show', 'desde_presente', v_desde_presente);
END;
$function$;

COMMENT ON FUNCTION public.recepcion_marcar_no_show(uuid, text) IS
  'Marca una reserva como no_show. Acepta confirmada (no llegó) o completada (corrige un check-in equivocado: limpia check_in_*). Crédito quemado, asiento ledger anti-doble, bitácora.';

-- ── Self-test: DEVUELVE TABLA (el editor esconde NOTICE) ────────────────────
SELECT
  'no-show desde presente' AS prueba,
  pg_get_functiondef('public.recepcion_marcar_no_show(uuid, text)'::regprocedure)
    LIKE '%NOT IN (''confirmada'', ''completada'')%'                         AS acepta_completada_ok,
  pg_get_functiondef('public.recepcion_marcar_no_show(uuid, text)'::regprocedure)
    LIKE '%check_in_at = CASE WHEN v_desde_presente THEN NULL%'              AS limpia_checkin_ok,
  pg_get_functiondef('public.recepcion_marcar_no_show(uuid, text)'::regprocedure)
    LIKE '%_registrar_no_show_ledger%'                                       AS ledger_ok,
  NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'recepcion_marcar_no_show'
      AND grantee = 'anon'
  )                                                                          AS sin_anon_ok;
