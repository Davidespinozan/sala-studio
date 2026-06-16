-- ============================================================================
-- DEMO → HEALTHYSPACE (B: borrar sala-demo)
-- ----------------------------------------------------------------------------
-- Corré esta migración SOLO después de validar que el demo funciona en
-- healthyspace (migración A + deploy del código nuevo). Hasta acá sala-demo
-- quedó como red de seguridad; ahora se elimina del todo.
--
-- usuarios.tenant_id es ON DELETE RESTRICT y reservas.usuario_id / .check_in_by
-- también bloquean, así que no se puede hacer un simple DELETE del tenant: hay
-- que vaciar en orden (hijas → usuarios → tenant). El DELETE final del tenant
-- cascada lo estructural restante (tiers, recursos, instructores, sucursales,
-- horarios_recurrentes, suscripciones_saas, payment_events y las columnas de
-- landing CMS que viven en la fila de tenants).
-- ============================================================================

DO $$
DECLARE
  v_demo uuid;
BEGIN
  SELECT id INTO v_demo FROM tenants WHERE slug = 'sala-demo';
  IF v_demo IS NULL THEN
    RAISE NOTICE 'sala-demo ya no existe; nada que borrar.';
    RETURN;
  END IF;

  -- Romper el ciclo usuarios <-> membresias antes de borrar membresías.
  UPDATE usuarios SET membresia_activa_id = NULL WHERE tenant_id = v_demo;

  -- Transaccional / lo que referencia a usuarios (RESTRICT/NO ACTION primero).
  DELETE FROM reservas                 WHERE tenant_id = v_demo;
  DELETE FROM lista_espera             WHERE tenant_id = v_demo;
  DELETE FROM notificaciones           WHERE tenant_id = v_demo;
  DELETE FROM socio_notas              WHERE tenant_id = v_demo;
  DELETE FROM usuario_status_historial WHERE tenant_id = v_demo;
  DELETE FROM membresia_movimientos    WHERE tenant_id = v_demo;
  DELETE FROM payment_events           WHERE tenant_id = v_demo;
  DELETE FROM membresias               WHERE tenant_id = v_demo;
  DELETE FROM clases                   WHERE tenant_id = v_demo;

  -- Cuentas de auth del seed (borra en cascada sus filas de usuarios).
  DELETE FROM auth.users
  WHERE id IN (SELECT auth_id FROM usuarios WHERE tenant_id = v_demo AND auth_id IS NOT NULL);

  -- Usuarios restantes (sin auth_id: invitados/sintéticos).
  DELETE FROM usuarios WHERE tenant_id = v_demo;

  -- El tenant: cascada lo estructural restante.
  DELETE FROM tenants WHERE id = v_demo;

  RAISE NOTICE 'sala-demo eliminado.';
END;
$$;
