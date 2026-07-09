-- ============================================================================
-- "Enviar aviso" a un socio desde recepción/admin (brecha vs ekko).
-- ----------------------------------------------------------------------------
-- Un mensaje in-app puntual ("tu clase se movió", etc.) → notificaciones (que ya
-- tiene realtime + campana). Gate admin/recepción, mismo tenant, y queda en la
-- bitácora (auditoria_recepcion) igual que el resto de acciones de mostrador.
-- ============================================================================

-- Agregar 'socio.aviso' al enum de acciones de la bitácora (lista vigente de
-- 20260613001700 + el nuevo valor).
ALTER TABLE auditoria_recepcion DROP CONSTRAINT IF EXISTS auditoria_recepcion_accion_check;
ALTER TABLE auditoria_recepcion ADD CONSTRAINT auditoria_recepcion_accion_check
  CHECK (accion IN (
    'membresia.renovar','membresia.cambiar_plan','membresia.recargar_creditos',
    'membresia.congelar','membresia.reactivar','membresia.cancelar',
    'reserva.crear','reserva.cancelar','reserva.lista_espera_anotar','reserva.lista_espera_promover',
    'socio.crear','socio.editar_contacto','socio.reset_password','socio.bloquear','socio.desbloquear','socio.nota','socio.aviso',
    'clase.crear','clase.cancelar','clase.editar','clase.reasignar_coach','clase.marcar_asistencia','clase.marcar_no_show',
    'pago.reenviar_link','pago.activar',
    'checkin.manual','checkin.qr','checkin.corregir'
  ));

CREATE OR REPLACE FUNCTION enviar_aviso_socio(
  p_usuario_id uuid,
  p_titulo text,
  p_mensaje text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_socio usuarios;
  v_notif_id uuid;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden enviar avisos';
  END IF;
  IF p_titulo IS NULL OR length(trim(p_titulo)) = 0 THEN
    RAISE EXCEPTION 'TITULO_REQUERIDO: el aviso necesita un título';
  END IF;
  IF p_mensaje IS NULL OR length(trim(p_mensaje)) = 0 THEN
    RAISE EXCEPTION 'MENSAJE_REQUERIDO: el aviso necesita un mensaje';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN RAISE EXCEPTION 'SOCIO_NO_EXISTE: el socio no existe'; END IF;
  IF v_socio.tenant_id <> v_tenant THEN RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio'; END IF;

  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (v_tenant, p_usuario_id, 'aviso', trim(p_titulo), trim(p_mensaje),
          jsonb_build_object('origen', 'manual'))
  RETURNING id INTO v_notif_id;

  PERFORM _audrec_log(
    'socio.aviso', 'socio', v_notif_id, p_usuario_id, v_socio.nombre,
    format('Le envió un aviso a %s: "%s".', COALESCE(v_socio.nombre, v_socio.email), trim(p_titulo)),
    jsonb_build_object('notif_id', v_notif_id, 'titulo', trim(p_titulo), 'mensaje', trim(p_mensaje))
  );

  RETURN jsonb_build_object('success', true, 'notif_id', v_notif_id);
END $$;

REVOKE ALL ON FUNCTION enviar_aviso_socio(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enviar_aviso_socio(uuid, text, text) TO authenticated;

-- ── Verificación (devuelve tabla) ──
SELECT 'función enviar_aviso_socio existe' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enviar_aviso_socio') AS ok
UNION ALL
SELECT 'socio.aviso en el enum de auditoría',
       (SELECT pg_get_constraintdef(oid) LIKE '%socio.aviso%'
        FROM pg_constraint WHERE conname = 'auditoria_recepcion_accion_check');
