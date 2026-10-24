-- ════════════════════════════════════════════════════════════════════════════
-- BASE DURABLE DE OPERACIONES DE CANCELACIÓN STRIPE (BLOCK 2A)
-- ────────────────────────────────────────────────────────────────────────────
-- Alcance de ESTE bloque: solo la base durable + autorización + transiciones
-- atómicas en Postgres. NO llama a Stripe, NO orquesta Netlify, NO trae
-- reconciliador — eso es BLOCK 2B/2C. Hoy esto no es alcanzable por ningún
-- usuario real (nada en el frontend lo invoca todavía).
--
-- Diseño (resumen de las rondas de diseño previas):
--   - `stripe_operaciones_cancelacion`: una fila por intento de "programar" o
--     "retirar" una cancelación Stripe. Índice único parcial
--     (membresia_id) WHERE estado='en_ejecucion' → a lo sumo UNA operación
--     viva por membresía, garantizado por el motor (constraint), no por un
--     chequeo manual con ventana de carrera.
--   - `iniciar_operacion_cancelacion`: resuelve el actor SIEMPRE desde
--     auth.uid() (nunca de un parámetro), autoriza (socio sobre sí mismo, o
--     recepción/admin sobre otro con motivo obligatorio + misma sede/tenant),
--     bloquea la fila de la membresía con FOR UPDATE (consistencia de la
--     decisión dentro de ESTA llamada — el lock se libera al commitear, no
--     puede mantenerse cruzando la llamada a Stripe que hace Netlify después,
--     porque son dos transacciones/llamadas RPC distintas), y hace INSERT.
--     La garantía durable de "una sola operación viva" la da el ÍNDICE
--     ÚNICO, no el lock de membresía (que solo ordena las decisiones DENTRO
--     de iniciar_operacion, no bloquea nada hasta que Netlify llame a
--     confirmar más tarde).
--   - `confirmar_operacion_cancelacion`: idempotente por `operacion_id`
--     (identidad persistente). Si la operación ya no está 'en_ejecucion',
--     es no-op informativo (no reaplica ni revierte). Si está vigente,
--     bloquea la fila de membresía, verifica que NO se haya vuelto terminal
--     mientras tanto, y aplica el mirror (cancelada_at/cancelada_efectiva_at)
--     — todo en la MISMA transacción que la transición de estado de la
--     operación (atomicidad real de Postgres, nunca "atomicidad distribuida"
--     con Stripe, que no existe y no se finge que existe).
--   - Operaciones que quedan ambiguas (Netlify muere entre llamar a Stripe y
--     llamar a confirmar): quedan en 'en_ejecucion' SIN que nada las libere
--     por el solo paso del tiempo — a propósito, por diseño. Su resolución
--     (reconciliador con doble lectura estable contra Stripe en vivo) es
--     BLOCK 2B, explícitamente fuera de este bloque. Mientras tanto, el
--     índice único actúa como freno seguro: nadie más puede iniciar una
--     operación nueva sobre esa membresía hasta que 2B exista, lo cual es
--     preferible a liberarla sin verificar contra Stripe.
--
-- Orden de locks (probado en sandbox, ver conversación): estas dos funciones
-- SOLO toman el lock de fila de `membresias` (M) — nunca de `reservas` (R) ni
-- `clases` (X). Por lo tanto son compatibles con cualquier camino existente
-- que use el orden canónico R → X → M (recepcion_cancelar_membresia,
-- _stripe_evaluar_cierre_membresia, _stripe_finalizar_membresia_diferida):
-- en el peor caso compiten por el MISMO lock M, que Postgres serializa sin
-- riesgo de deadlock (un solo recurso, nunca dos recursos en órdenes
-- cruzados). No hay ninguna ruta nueva de deadlock introducida.
--
-- _audrec_log se llama desde iniciar_operacion_cancelacion SOLO cuando el
-- actor es staff operando sobre otro socio (_audrec_log es exclusivo de
-- recepcionista/admin por diseño — confirmado en sandbox: lanza NO_AUTORIZADO
-- si el actor es 'miembro'). El self-serve del socio sobre sí mismo nunca la
-- llama, igual que cancelar-membresia/index.ts hoy tampoco lo hace.
--
-- Nada de esto toca créditos, reservas ni ledger. Nada de esto modifica
-- BLOCK1A ni BLOCK1B+1C — son archivos y funciones completamente separados.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1) Tabla durable ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_operaciones_cancelacion (
  id                     uuid PRIMARY KEY,
  membresia_id           uuid NOT NULL REFERENCES membresias(id) ON DELETE RESTRICT,
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  accion                 text NOT NULL CHECK (accion IN ('programar', 'retirar')),

  -- Auditoría del actor ORIGINAL — nunca se reescribe tras crearse.
  actor_usuario_id       uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  actor_rol              text NOT NULL,
  actor_sucursal_id      uuid,
  motivo                 text,

  estado                 text NOT NULL DEFAULT 'en_ejecucion'
                           CHECK (estado IN ('en_ejecucion', 'confirmada', 'reconciliada')),
  resuelto_por           text CHECK (resuelto_por IN ('interactivo', 'reconciliador')),

  -- Para el reconciliador de BLOCK 2B (doble lectura estable). No usado aún.
  reconciliador_ultima_lectura   jsonb,
  reconciliador_ultima_revision  timestamptz,

  resultado              jsonb,
  ultimo_error           text,
  intentos_confirmacion  integer NOT NULL DEFAULT 0,

  creada_at              timestamptz NOT NULL DEFAULT now(),
  confirmada_at          timestamptz,
  reconciliada_at        timestamptz
);

-- A lo sumo UNA operación viva por membresía. Es la garantía durable real
-- (no el lock de fila de membresias, que no se sostiene entre llamadas).
CREATE UNIQUE INDEX IF NOT EXISTS uq_stripe_operacion_viva
  ON stripe_operaciones_cancelacion (membresia_id)
  WHERE estado = 'en_ejecucion';

CREATE INDEX IF NOT EXISTS idx_stripe_operaciones_tenant
  ON stripe_operaciones_cancelacion (tenant_id, creada_at);

-- Mismo patrón que stripe_event_inbox/stripe_disputas: RLS sin policies
-- (deny-all para anon/authenticated), acceso exclusivo vía RPC SECURITY DEFINER.
ALTER TABLE stripe_operaciones_cancelacion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stripe_operaciones_cancelacion FROM PUBLIC, anon, authenticated;

-- Agregar los 2 valores nuevos al enum de acciones de la bitácora (lista
-- vigente de 20260714100000 + 'membresia.programar_cancelacion_stripe' y
-- 'membresia.retirar_cancelacion_stripe'). Mismo patrón que cada migración
-- anterior que agregó una acción nueva: DROP + ADD con la lista completa.
--
-- BLOCK2J: entre que se escribió esta migración y que se preparó para aplicar,
-- 20261011100000_descuentos_por_socio.sql (ya en producción) hizo su propio
-- DROP+ADD de esta MISMA restricción y agregó 'socio.descuento_otorgar'/
-- 'socio.descuento_quitar' (además de copiar los 2 valores de Stripe de acá).
-- La lista de abajo es la UNIÓN real verificada contra el catálogo de
-- producción (38 valores) — no la lista de 36 que tenía esta migración
-- originalmente. Sin este ajuste, aplicar esta migración tal cual habría
-- vuelto a dejar la restricción en 36 valores, rompiendo en silencio el
-- otorgamiento/retiro de descuentos (nadie lo nota hasta el primer intento
-- real, porque ADD CONSTRAINT solo valida filas existentes, no las futuras).
ALTER TABLE auditoria_recepcion DROP CONSTRAINT IF EXISTS auditoria_recepcion_accion_check;
ALTER TABLE auditoria_recepcion ADD CONSTRAINT auditoria_recepcion_accion_check
  CHECK (accion IN (
    'membresia.ajustar_creditos','membresia.alta','membresia.renovar','membresia.cambiar_plan',
    'membresia.recargar_creditos','membresia.congelar','membresia.reactivar','membresia.cancelar',
    'membresia.programar_cancelacion_stripe','membresia.retirar_cancelacion_stripe',
    'reserva.crear','reserva.cancelar','reserva.lista_espera_anotar','reserva.lista_espera_promover',
    'socio.crear','socio.editar_contacto','socio.reset_password','socio.bloquear','socio.desbloquear',
    'socio.nota','socio.aviso','socio.huella_enrolar','socio.huella_revocar',
    'socio.descuento_otorgar','socio.descuento_quitar',
    'clase.crear','clase.cancelar','clase.editar','clase.reasignar_coach','clase.marcar_asistencia','clase.marcar_no_show',
    'pago.reenviar_link','pago.activar','pago.reembolso',
    'checkin.manual','checkin.qr','checkin.corregir','checkin.huella'
  ));

-- ── 2) Iniciar una operación ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iniciar_operacion_cancelacion(
  p_operacion_id uuid,
  p_usuario_id uuid,
  p_accion text,
  p_motivo text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor RECORD;
  v_mem RECORD;
  v_es_propio boolean;
BEGIN
  IF p_operacion_id IS NULL THEN
    RAISE EXCEPTION 'OPERACION_ID_REQUERIDO';
  END IF;
  IF p_accion NOT IN ('programar', 'retirar') THEN
    RAISE EXCEPTION 'ACCION_INVALIDA: %', p_accion;
  END IF;

  SELECT id, tenant_id, rol, sucursal_id, status INTO v_actor
  FROM usuarios WHERE auth_id = auth.uid();
  IF v_actor.id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: actor no resuelto';
  END IF;
  IF v_actor.status <> 'activo' THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: actor inactivo';
  END IF;

  v_es_propio := (v_actor.id = p_usuario_id);

  IF v_es_propio THEN
    IF v_actor.rol <> 'miembro' THEN
      RAISE EXCEPTION 'ROL_INVALIDO: esta ruta de auto-gestión es solo para socios';
    END IF;
  ELSE
    IF v_actor.rol NOT IN ('recepcionista', 'admin') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden operar sobre otro socio';
    END IF;
    IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
      RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para esta acción';
    END IF;
  END IF;

  SELECT m.id, m.tenant_id, m.sucursal_id, m.status, m.stripe_subscription_id, m.cancelada_at
  INTO v_mem
  FROM membresias m
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF NOT v_es_propio THEN
    PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  END IF;

  IF v_mem.stripe_subscription_id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_SIN_STRIPE: esta membresía no tiene suscripción de Stripe; usa el flujo manual';
  END IF;
  IF v_mem.status IN ('cancelada', 'expirada') THEN
    RAISE EXCEPTION 'MEMBRESIA_TERMINAL: esta membresía ya está cerrada';
  END IF;
  IF p_accion = 'retirar' AND v_mem.cancelada_at IS NULL THEN
    RAISE EXCEPTION 'SIN_CANCELACION_PENDIENTE: no hay ninguna cancelación programada para retirar';
  END IF;
  IF p_accion = 'programar' AND v_mem.cancelada_at IS NOT NULL THEN
    RAISE EXCEPTION 'CANCELACION_YA_PENDIENTE: ya hay una cancelación programada';
  END IF;

  BEGIN
    INSERT INTO stripe_operaciones_cancelacion (
      id, membresia_id, tenant_id, accion, actor_usuario_id, actor_rol, actor_sucursal_id, motivo
    ) VALUES (
      p_operacion_id, v_mem.id, v_mem.tenant_id, p_accion, v_actor.id, v_actor.rol, v_actor.sucursal_id, p_motivo
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'operacion_en_curso');
  END;

  -- _audrec_log es exclusivo de staff (recepcionista/admin) — lanza NO_AUTORIZADO
  -- para 'miembro'. El self-serve del socio sobre su propia membresía nunca
  -- escribe esta bitácora (igual que cancelar-membresia/index.ts hoy no lo hace).
  IF NOT v_es_propio THEN
    PERFORM _audrec_log(
      'membresia.' || p_accion || '_cancelacion_stripe', 'membresia', v_mem.id,
      p_usuario_id, NULL, p_motivo,
      jsonb_build_object('operacion_id', p_operacion_id, 'accion', p_accion)
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'operacion_id', p_operacion_id, 'membresia_id', v_mem.id,
    'stripe_subscription_id', v_mem.stripe_subscription_id
  );
END; $$;

REVOKE ALL ON FUNCTION iniciar_operacion_cancelacion(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION iniciar_operacion_cancelacion(uuid, uuid, text, text) TO authenticated, service_role;

-- ── 3) Confirmar una operación (idempotente) ────────────────────────────────
-- SEGURIDAD (BLOCK2H): esta función escribe el RESULTADO ECONÓMICO de una
-- llamada a Stripe que YA DEBIÓ HABER OCURRIDO — no autoriza nada, CONFÍA en
-- que quien la llama ya verificó con Stripe. Si fuera callable por
-- `authenticated` (como en una versión anterior, nunca desplegada a
-- producción), CUALQUIER socio podría llamarla directo desde el navegador con
-- p_exito=true y una p_period_end_fresco fabricada, sin que Stripe haya sido
-- tocado jamás — probado en sandbox (BLOCK2H, ver conversación). Por eso es
-- EXCLUSIVA de service_role (nunca `authenticated`): solo Netlify, que ya
-- llamó a Stripe de verdad y ya resolvió el actor real desde su JWT ANTES de
-- esta llamada, puede invocarla. `p_actor_usuario_id` ya no se resuelve de
-- auth.uid() (no hay sesión de usuario bajo service_role) — lo pasa el
-- caller, y el chequeo de pertenencia sigue siendo el mismo (no podés
-- confirmar una operación que no es la tuya), solo que ahora la fuente de
-- verdad del actor es el JWT que Netlify ya validó, no un parámetro que un
-- cliente pudiera fabricar (igual que el fix de IDOR de BLOCK2C).
CREATE OR REPLACE FUNCTION confirmar_operacion_cancelacion(
  p_operacion_id uuid,
  p_actor_usuario_id uuid,
  p_period_end_fresco timestamptz DEFAULT NULL,
  p_exito boolean DEFAULT true,
  p_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_op RECORD;
  v_mem_status text;
BEGIN
  IF p_actor_usuario_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: falta el actor que confirma';
  END IF;

  SELECT * INTO v_op FROM stripe_operaciones_cancelacion WHERE id = p_operacion_id FOR UPDATE;
  IF v_op.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'operacion_no_existe');
  END IF;
  IF v_op.actor_usuario_id IS DISTINCT FROM p_actor_usuario_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: no podés confirmar una operación de otro actor';
  END IF;

  UPDATE stripe_operaciones_cancelacion
  SET intentos_confirmacion = intentos_confirmacion + 1
  WHERE id = p_operacion_id;

  -- Idempotencia por identidad de operación: si ya no está en_ejecucion
  -- (confirmada antes, o reconciliada por BLOCK2B en el futuro), no-op
  -- informativo — nunca reaplica ni revierte.
  IF v_op.estado <> 'en_ejecucion' THEN
    RETURN jsonb_build_object('ok', true, 'idempotente', true, 'estado', v_op.estado, 'resultado', v_op.resultado);
  END IF;

  IF NOT p_exito THEN
    UPDATE stripe_operaciones_cancelacion
    SET estado = 'confirmada', resuelto_por = 'interactivo', confirmada_at = now(),
        resultado = jsonb_build_object('aplicado', false, 'motivo', 'stripe_fallo'),
        ultimo_error = p_error
    WHERE id = p_operacion_id;
    RETURN jsonb_build_object('ok', true, 'aplicado', false);
  END IF;

  SELECT status INTO v_mem_status FROM membresias WHERE id = v_op.membresia_id FOR UPDATE;

  UPDATE stripe_operaciones_cancelacion
  SET estado = 'confirmada', resuelto_por = 'interactivo', confirmada_at = now(),
      resultado = jsonb_build_object('aplicado', true, 'period_end_fresco', p_period_end_fresco)
  WHERE id = p_operacion_id;

  IF v_mem_status IN ('cancelada', 'expirada') THEN
    -- Se volvió terminal mientras la operación estaba en curso (ej. 1C la
    -- cerró, o una terminación administrativa). La operación queda
    -- registrada como confirmada con Stripe, pero SALA no se toca.
    RETURN jsonb_build_object('ok', true, 'aplicado', true, 'membresia_terminal', true);
  END IF;

  IF v_op.accion = 'programar' THEN
    UPDATE membresias
    SET cancelada_at = COALESCE(cancelada_at, now()), cancelada_efectiva_at = p_period_end_fresco
    WHERE id = v_op.membresia_id;
  ELSE
    UPDATE membresias
    SET cancelada_at = NULL, cancelada_efectiva_at = NULL
    WHERE id = v_op.membresia_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'aplicado', true, 'membresia_id', v_op.membresia_id);
END; $$;

-- DROP explícito del overload anterior (uuid, timestamptz, boolean, text):
-- CREATE OR REPLACE no alcanza para esto — una firma de parámetros distinta
-- crea una función NUEVA y deja la vieja (con su GRANT a `authenticated`)
-- viva en paralelo. Nunca se desplegó a producción, así que no hay nada que
-- migrar/retirar del lado de datos — solo limpiar el catálogo local.
DROP FUNCTION IF EXISTS confirmar_operacion_cancelacion(uuid, timestamptz, boolean, text);

REVOKE ALL ON FUNCTION confirmar_operacion_cancelacion(uuid, uuid, timestamptz, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION confirmar_operacion_cancelacion(uuid, uuid, timestamptz, boolean, text) TO service_role;
