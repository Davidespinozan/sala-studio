-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- RECEPCIÓN puede corregir la asistencia (no solo el admin).
-- ────────────────────────────────────────────────────────────────────────────
-- Pasa seguido: el socio SÍ fue, pero nadie le hizo el check-in → el cron lo marca
-- `no_show` (o quedó `cancelada` por error). Antes solo el admin podía corregirlo
-- (`admin_marcar_asistencia` con `IF NOT is_admin()`), y NO aceptaba canceladas.
-- numa lo necesita desde el mostrador.
--
-- Cambios en `admin_marcar_asistencia`:
--   • Permite recepción O admin (antes solo admin).
--   • Acepta también `cancelada`/`cancelada_admin` → presente (antes las rechazaba).
--   • Guarda: no se puede marcar asistencia de una clase que TODAVÍA no empieza
--     (slot en el futuro). Esto hace seguro reactivar una cancelada: solo aplica a
--     clases ya pasadas, donde el cupo y la lista de espera ya no importan.
--   • El crédito NO se re-cobra acá (la corrección es del registro de asistencia,
--     no un re-cobro): un no_show mantuvo el crédito consumido; una cancelada lo
--     devolvió y así se queda. Para planes por tiempo (numa) es indistinto.
-- ════════════════════════════════════════════════════════════════════════════

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

  -- Recepción Y admin: corregir "no le hicieron el check-in" es del mostrador.
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden corregir la asistencia';
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

  -- No se puede "haber asistido" a una clase que todavía no empieza. Además hace
  -- seguro reactivar una cancelada: solo clases pasadas (cupo/lista de espera ya
  -- no importan).
  IF v_reserva.slot_inicio > now() THEN
    RAISE EXCEPTION 'CLASE_NO_INICIADA: Esa clase todavía no empieza; no se puede marcar asistencia';
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = now(),
      check_in_by = v_actor,
      check_in_method = 'manual',
      updated_at = now()
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;

  PERFORM _audrec_log(
    'clase.marcar_asistencia', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
    format('Corrigió la asistencia a "presente" en la clase de %s.%s',
           to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                THEN ' Motivo: ' || p_motivo ELSE '' END),
    jsonb_build_object('motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id);
END;
$$;

REVOKE ALL ON FUNCTION admin_marcar_asistencia(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_marcar_asistencia(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION admin_marcar_asistencia(uuid, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA (contrato): la función ya permite recepción, ya no
-- rechaza canceladas, y tiene el guardia de clase futura.
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'admin_marcar_asistencia' AS prueba,
  pg_get_functiondef('admin_marcar_asistencia(uuid, text)'::regprocedure) ILIKE '%is_recepcionista()%'      AS permite_recepcion,
  pg_get_functiondef('admin_marcar_asistencia(uuid, text)'::regprocedure) NOT ILIKE '%RESERVA_CANCELADA%'   AS acepta_canceladas,
  pg_get_functiondef('admin_marcar_asistencia(uuid, text)'::regprocedure) ILIKE '%CLASE_NO_INICIADA%'       AS guardia_clase_futura;
