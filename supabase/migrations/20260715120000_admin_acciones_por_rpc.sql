-- ============================================================================
-- La misma acción daba resultados distintos según la pantalla
-- ----------------------------------------------------------------------------
-- Las "acciones rápidas" del admin sobre una reserva (desde la agenda y desde la
-- lista de inscritos) hacían UPDATE directo a `reservas`, salteándose las RPCs
-- que existen justo para eso. Consecuencias reales, hoy, en producción:
--
--   · CANCELAR desde la agenda NO devolvía el crédito al socio. Cancelar al
--     mismo socio desde su ficha SÍ (esa pantalla usa cancelar_reserva_admin).
--     El socio recuperaba o perdía su clase según por dónde entró el admin.
--   · NO-SHOW desde la agenda no pasaba por el ledger: la falta no existía en
--     `membresia_movimientos`, así que los reportes de asistencia mentían.
--   · ASISTENCIA no quedaba en la bitácora de recepción (auditoria_recepcion):
--     nadie podía saber quién marcó presente a quién.
--   · Ninguna de las tres validaba tenant. Un UPDATE con RLS es más laxo que una
--     RPC: la policy deja tocar la fila, pero no revisa reglas de negocio.
--
-- El front pasa a llamar cancelar_reserva_admin y recepcion_marcar_no_show (ya
-- existían). Falta una sola pieza: marcar asistencia. La de recepción
-- (check_in_manual_atomic) exige estar dentro de la ventana de check-in, y eso
-- es correcto en el mostrador pero no acá: el admin también corrige la lista de
-- una clase de ayer. Esta RPC es esa corrección — sin ventana, a propósito, pero
-- con bitácora, que es lo que faltaba.
-- ============================================================================

CREATE OR REPLACE FUNCTION admin_marcar_asistencia(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_miembro usuarios;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  -- Corregir la lista después del hecho es potestad del admin, no del mostrador.
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo el admin puede corregir la asistencia. '
                    'En el mostrador se usa el check-in.';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro gimnasio';
  END IF;

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este socio ya figura como presente';
  END IF;

  IF v_reserva.status IN ('cancelada', 'cancelada_admin') THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: La reserva fue cancelada';
  END IF;

  -- Un no_show SÍ se puede corregir a presente: es exactamente el error que esta
  -- función existe para arreglar (el socio fue, nadie lo checó, el cron lo marcó).
  UPDATE reservas
  SET status = 'completada',
      check_in_at = now(),
      check_in_by = v_actor,
      check_in_method = 'manual'
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;

  PERFORM _audrec_log(
    'asistencia.admin', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
    format('Asistencia marcada por admin en la clase de %s.%s',
           to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                THEN ' Motivo: ' || p_motivo ELSE '' END),
    jsonb_build_object('method', 'admin', 'motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id);
END;
$$;

REVOKE ALL ON FUNCTION admin_marcar_asistencia(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_marcar_asistencia(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION admin_marcar_asistencia(uuid, text) TO authenticated;


-- ============================================================================
-- SELF-TEST
-- ============================================================================
SELECT
  'admin_marcar_asistencia existe' AS prueba,
  'SECURITY DEFINER' AS espera,
  CASE WHEN count(*) = 1 THEN 'OK' ELSE 'FALLA' END AS resultado
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'admin_marcar_asistencia'
  AND p.prosecdef

UNION ALL

SELECT
  'deja bitácora',
  'llama a _audrec_log',
  CASE WHEN p.prosrc LIKE '%_audrec_log%' THEN 'OK' ELSE 'FALLA' END
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'admin_marcar_asistencia'

UNION ALL

SELECT
  'anon no la puede llamar',
  'sin EXECUTE para anon',
  CASE WHEN has_function_privilege('anon', 'admin_marcar_asistencia(uuid, text)', 'EXECUTE')
       THEN 'FALLA' ELSE 'OK' END;
