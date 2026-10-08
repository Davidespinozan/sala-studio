-- ════════════════════════════════════════════════════════════════════════════
-- CONTENCIÓN · recepcion_cancelar_membresia (BLOCK 1A — CANCELLATION SAFETY)
-- ────────────────────────────────────────────────────────────────────────────
-- Problema que cierra: recepcion_cancelar_membresia cancela la membresía de
-- forma INMEDIATA en SALA sin tocar Stripe. Para una membresía respaldada por
-- Stripe, esto corta el acceso del socio mientras la suscripción sigue
-- generando cobros — nadie detiene la facturación. Confirmado por auditoría:
-- cero interacción con Stripe en el cuerpo de esta función, y ningún caller
-- de frontend (reception/admin) llama a Stripe por su cuenta tampoco.
--
-- Este bloque es CONTENCIÓN, no el rediseño completo (eso es Fase 2/4,
-- pendiente del flujo de no-renovación y del contrato económico de la
-- terminación excepcional). Dos cambios, ambos aditivos sobre el cuerpo ya
-- cerrado, reproducido VERBATIM salvo lo señalado:
--
--   1) Rol: is_recepcionista() OR is_admin() → is_admin() únicamente.
--      Recepción deja de poder usar esta ruta de inmediato.
--   2) Guard de cuerpo nuevo: si la membresía objetivo tiene
--      stripe_subscription_id IS NOT NULL, se rechaza con
--      STRIPE_CANCELACION_MANUAL_REQUERIDA — en vez de cortar el acceso
--      silenciosamente mientras el cobro sigue. Las membresías manuales
--      (sin Stripe) siguen funcionando exactamente igual que antes.
--
-- Nada más cambia: mismo orden de locks R→X→M, mismo _liberar_reservas_membresia,
-- misma auditoría, mismos mensajes de error existentes, misma firma pública.
--
-- Verificado que no hay forma de eludir esto vía otra ruta de RPC: la única
-- firma viva de esta función es (uuid, text) — las apariciones anteriores en
-- el historial de migraciones son redefiniciones sucesivas de la MISMA firma,
-- no sobrecargas. No existe ninguna otra función que escriba
-- membresias.status='cancelada'. Riesgo residual, fuera de alcance de este
-- bloque: la política membresias_admin_all (RLS, ya existente desde
-- 20260514100800) permite a un admin escribir la fila de membresías
-- directamente por REST, evadiendo cualquier RPC — es un patrón de confianza
-- de admin ya presente en toda la app, no algo introducido ni corregible
-- aquí sin un rediseño de RLS mucho más amplio.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.recepcion_cancelar_membresia(p_usuario_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
  v_target uuid;
  v_target_tenant uuid;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo un administrador puede cancelar una membresía por esta vía';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cancelar la membresía';
  END IF;

  -- Orden canónico R → X → M: identificar la membresía (sin lock) y bloquear
  -- sus reservas liberables y clases ANTES de la fila de la membresía.
  SELECT m.id, m.tenant_id INTO v_target, v_target_tenant
  FROM membresias m
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_target IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_target_tenant <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;

  PERFORM _bloquear_fin_membresias(ARRAY[v_target]);

  SELECT m.id, m.status, m.tenant_id, u.nombre, m.sucursal_id, m.stripe_subscription_id
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.id <> v_target THEN
    RAISE EXCEPTION 'MEMBRESIA_CAMBIO_CONCURRENTE: la membresía del socio cambió mientras se procesaba; intenta de nuevo';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  IF v_mem.status = 'cancelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_CANCELADA: la membresía ya estaba cancelada';
  END IF;

  -- Contención (BLOCK 1A): una membresía respaldada por Stripe no se cancela
  -- por esta vía — cortaría el acceso sin detener el cobro. El flujo correcto
  -- (Stripe primero, SALA después) se construye en una fase posterior.
  IF v_mem.stripe_subscription_id IS NOT NULL THEN
    RAISE EXCEPTION 'STRIPE_CANCELACION_MANUAL_REQUERIDA: esta membresía tiene una suscripción de Stripe activa; cancelala en Stripe antes de continuar';
  END IF;

  UPDATE membresias
  SET status = 'cancelada', cancelada_at = now(), updated_at = now()
  WHERE id = v_mem.id;

  -- Cache: el trigger de W5-B también lo limpia; se mantiene por robustez.
  UPDATE usuarios
  SET membresia_tier = NULL, membresia_activa_id = NULL
  WHERE id = p_usuario_id;

  -- #17A-2: la membresía perdió entitlement de verdad (cancelación inmediata) →
  -- liberar sus reservas futuras membership-dependent sin débito.
  PERFORM _liberar_reservas_membresia(v_mem.id);

  PERFORM _audrec_log(
    'membresia.cancelar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Canceló la membresía. Motivo: %s', p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', v_mem.status)
  );

  RETURN jsonb_build_object('success', true, 'status', 'cancelada');
END;
$function$;
