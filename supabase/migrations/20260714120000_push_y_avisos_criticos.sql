-- ============================================================================
-- NOTIFICACIONES PUSH + los avisos que faltaban
-- ----------------------------------------------------------------------------
-- Estado antes de esto:
--   · Push: NO EXISTÍA. Ni service worker de push, ni claves, ni tabla, ni envío.
--     Si el socio no abría la app, no se enteraba de nada.
--   · La campana in-app existe para los TRES roles, pero solo el socio recibía
--     algo: ningún evento escribía una notificación dirigida a un admin o a un
--     recepcionista. La campana del gym estaba SIEMPRE vacía.
--   · Eventos sin aviso: pago rechazado, membresía por vencer, membresía vencida,
--     bloqueo por inasistencias, socio nuevo, cancelación de última hora.
--
-- Diseño del push: en vez de cablear el envío en cada lugar que notifica (y
-- olvidarse de la mitad, como pasó en ekko), la tabla `notificaciones` gana un
-- `push_enviado_at` y un cron reparte lo pendiente. Así CUALQUIER notificación
-- —venga de un RPC, de un trigger o de un webhook— sale por push sin tocar más
-- código. El push es entrega adicional: la notificación in-app siempre queda.
-- ============================================================================

-- ── 1) Suscripciones push del navegador ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  -- Identifica al navegador/dispositivo. Único: re-suscribirse actualiza.
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE push_subscriptions IS
  'Un registro por navegador/dispositivo suscrito a push. Sirve para los TRES roles: el socio, la recepción y el admin.';

CREATE INDEX IF NOT EXISTS push_subs_usuario_idx ON push_subscriptions (usuario_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Cada quien gestiona SOLO sus propias suscripciones. El envío va por
-- service_role (el cron), que se saltea la RLS.
DROP POLICY IF EXISTS push_subs_self ON push_subscriptions;
CREATE POLICY push_subs_self ON push_subscriptions
  FOR ALL
  TO authenticated
  USING (usuario_id = get_my_user_id())
  WITH CHECK (usuario_id = get_my_user_id());

-- ── 2) La notificación recuerda si ya salió por push ────────────────────────
ALTER TABLE notificaciones
  ADD COLUMN IF NOT EXISTS push_enviado_at timestamptz;

COMMENT ON COLUMN notificaciones.push_enviado_at IS
  'NULL = todavía no salió por push. El cron toma las pendientes y las manda; así toda notificación nueva sale por push sin cablear el envío en cada disparador.';

-- Índice para que el cron encuentre lo pendiente sin escanear la tabla entera.
CREATE INDEX IF NOT EXISTS notif_push_pendientes_idx
  ON notificaciones (creada_at)
  WHERE push_enviado_at IS NULL;

-- ── 3) Avisar AL GYM (admin + recepción) ────────────────────────────────────
-- No existía forma de notificar al staff: todos los INSERT apuntaban al socio.
CREATE OR REPLACE FUNCTION notificar_staff(
  p_tenant_id uuid,
  p_tipo text,
  p_titulo text,
  p_mensaje text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  SELECT p_tenant_id, u.id, p_tipo, p_titulo, p_mensaje, p_metadata
  FROM usuarios u
  WHERE u.tenant_id = p_tenant_id
    AND u.rol IN ('admin', 'recepcionista')
    AND u.status = 'activo';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION notificar_staff(uuid, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notificar_staff(uuid, text, text, text, jsonb) TO service_role;

-- ── 4) Socio nuevo → avisar al gym ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_notificar_socio_nuevo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.rol = 'miembro' THEN
    PERFORM notificar_staff(
      NEW.tenant_id,
      'socio_nuevo',
      'Nuevo socio',
      COALESCE(NEW.nombre, NEW.email) || ' se dio de alta.',
      jsonb_build_object('usuario_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notificar_socio_nuevo ON usuarios;
CREATE TRIGGER notificar_socio_nuevo
  AFTER INSERT ON usuarios
  FOR EACH ROW EXECUTE FUNCTION trg_notificar_socio_nuevo();

-- ── 5) Membresía por vencer → avisar al socio ───────────────────────────────
-- El hueco más caro: nadie le avisaba al socio que su plan estaba por terminar.
ALTER TABLE membresias
  ADD COLUMN IF NOT EXISTS aviso_vencimiento_at timestamptz;

COMMENT ON COLUMN membresias.aviso_vencimiento_at IS
  'Cuándo se le avisó al socio que su plan estaba por vencer. Evita repetir el aviso todos los días.';

CREATE OR REPLACE FUNCTION avisar_membresias_por_vencer(p_dias integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT m.id, m.usuario_id, m.tenant_id, m.periodo_actual_fin, t.nombre AS tier_nombre
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.status IN ('activa', 'trialing')
      AND m.periodo_actual_fin IS NOT NULL
      AND m.periodo_actual_fin > now()
      AND m.periodo_actual_fin <= now() + (p_dias || ' days')::interval
      -- Todavía no se le avisó de ESTE periodo.
      AND (m.aviso_vencimiento_at IS NULL OR m.aviso_vencimiento_at < m.periodo_actual_inicio)
  LOOP
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      r.tenant_id, r.usuario_id, 'membresia_por_vencer',
      'Tu plan está por vencer',
      'Tu ' || r.tier_nombre || ' vence el ' ||
        to_char(r.periodo_actual_fin, 'DD/MM') || '. Renovalo para seguir reservando.',
      jsonb_build_object('membresia_id', r.id, 'vence', r.periodo_actual_fin)
    );

    UPDATE membresias SET aviso_vencimiento_at = now() WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION avisar_membresias_por_vencer(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION avisar_membresias_por_vencer(integer) TO service_role;

-- ── 6) Membresía vencida → avisar al socio (el cron la mataba en silencio) ──
CREATE OR REPLACE FUNCTION expirar_membresias_vencidas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH expiradas AS (
    UPDATE membresias
    SET status = 'expirada', updated_at = now()
    WHERE status IN ('activa', 'trialing', 'past_due')
      AND stripe_subscription_id IS NULL            -- Stripe → lo maneja el webhook
      AND periodo_actual_fin IS NOT NULL            -- NULL = plan sin vencimiento (créditos)
      AND periodo_actual_fin < now()
    RETURNING id, usuario_id, tenant_id
  ),
  limpiar_cache AS (
    UPDATE usuarios u
    SET membresia_tier = NULL, membresia_activa_id = NULL
    FROM expiradas e
    WHERE u.id = e.usuario_id
      AND u.membresia_activa_id = e.id
    RETURNING u.id
  ),
  avisar AS (
    -- NUEVO: el socio se enteraba de que venció al intentar reservar.
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje)
    SELECT e.tenant_id, e.usuario_id, 'membresia_vencida',
           'Tu plan venció',
           'Renovalo para volver a reservar. Podés hacerlo desde tu perfil o en el mostrador.'
    FROM expiradas e
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM expiradas;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION expirar_membresias_vencidas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expirar_membresias_vencidas() TO service_role;

-- ── 7) No-show + bloqueo → avisar al socio ──────────────────────────────────
-- Antes el socio quedaba bloqueado sin enterarse: lo descubría al intentar
-- reservar y no poder.
CREATE OR REPLACE FUNCTION marcar_no_shows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservas_afectadas integer := 0;
  v_usuarios_bloqueados integer := 0;
  v_now timestamptz := now();
  v_bloqueo_dias integer;
  v_bloqueado_hasta timestamptz;
  r record;
BEGIN
  FOR r IN
    SELECT
      res.id,
      res.usuario_id,
      res.tenant_id,
      res.folio,
      t.config AS tenant_config
    FROM reservas res
    JOIN tenants t ON t.id = res.tenant_id
    WHERE res.status = 'confirmada'
      AND res.check_in_at IS NULL
      AND res.slot_fin + interval '30 minutes' < v_now
  LOOP
    v_bloqueo_dias := COALESCE(
      (r.tenant_config->'penalizaciones'->>'no_show_bloqueo_dias')::integer,
      (r.tenant_config->>'no_show_bloqueo_dias')::integer,
      7
    );

    UPDATE reservas SET status = 'no_show' WHERE id = r.id;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    PERFORM _registrar_no_show_ledger(r.id, NULL);

    UPDATE usuarios
    SET bloqueado_hasta = GREATEST(
          COALESCE(bloqueado_hasta, v_now),
          v_now + (v_bloqueo_dias || ' days')::interval
        )
    WHERE id = r.usuario_id
    RETURNING bloqueado_hasta INTO v_bloqueado_hasta;
    v_usuarios_bloqueados := v_usuarios_bloqueados + 1;

    -- NUEVO: avisarle. Una penalización silenciosa es una mala penalización.
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      r.tenant_id, r.usuario_id, 'no_show',
      'No asististe a tu clase',
      'Se registró una inasistencia (' || COALESCE(r.folio, 'reserva') || '). No vas a poder reservar hasta el '
        || to_char(v_bloqueado_hasta, 'DD/MM') || '.',
      jsonb_build_object('reserva_id', r.id, 'bloqueado_hasta', v_bloqueado_hasta)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'timestamp', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION marcar_no_shows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marcar_no_shows() TO service_role;

-- ── 8) Cancelación de ÚLTIMA HORA → avisar al gym ───────────────────────────
-- El gym necesita saber que se le liberó un lugar sobre la hora (para llamar a
-- alguien de la lista, o simplemente para no esperar a quien no viene).
CREATE OR REPLACE FUNCTION trg_avisar_cancelacion_tardia()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_socio text;
BEGIN
  -- Solo cuando pasa a 'cancelada' y la clase empieza en menos de 4 horas.
  IF NEW.status = 'cancelada' AND OLD.status = 'confirmada'
     AND NEW.slot_inicio > now()
     AND NEW.slot_inicio < now() + interval '4 hours' THEN
    SELECT COALESCE(nombre, email) INTO v_socio FROM usuarios WHERE id = NEW.usuario_id;
    PERFORM notificar_staff(
      NEW.tenant_id,
      'cancelacion_tardia',
      'Cancelación de última hora',
      COALESCE(v_socio, 'Un socio') || ' canceló su reserva de las '
        || to_char(NEW.slot_inicio, 'HH24:MI') || '.',
      jsonb_build_object('reserva_id', NEW.id, 'usuario_id', NEW.usuario_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS avisar_cancelacion_tardia ON reservas;
CREATE TRIGGER avisar_cancelacion_tardia
  AFTER UPDATE OF status ON reservas
  FOR EACH ROW EXECUTE FUNCTION trg_avisar_cancelacion_tardia();

-- ============================================================================
-- SELF-TEST — devuelve TABLA.
-- ============================================================================
WITH checks AS (
  SELECT 'tabla push_subscriptions' AS prueba,
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'push_subscriptions') AS ok
  UNION ALL
  SELECT 'push_subscriptions con RLS (cada uno ve solo las suyas)',
         COALESCE((SELECT relrowsecurity FROM pg_class WHERE relname = 'push_subscriptions'), false)
  UNION ALL
  SELECT 'notificaciones.push_enviado_at (el cron reparte lo pendiente)',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'notificaciones' AND column_name = 'push_enviado_at')
  UNION ALL
  SELECT 'notificar_staff (avisar al admin/recepción)',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'notificar_staff')
  UNION ALL
  SELECT 'aviso: socio nuevo → al gym',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'notificar_socio_nuevo')
  UNION ALL
  SELECT 'aviso: cancelación de última hora → al gym',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'avisar_cancelacion_tardia')
  UNION ALL
  SELECT 'aviso: membresía por vencer → al socio',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'avisar_membresias_por_vencer')
  UNION ALL
  SELECT 'aviso: membresía vencida → al socio',
         (SELECT pg_get_functiondef(oid) LIKE '%membresia_vencida%'
            FROM pg_proc WHERE proname = 'expirar_membresias_vencidas' LIMIT 1)
  UNION ALL
  SELECT 'aviso: no-show y bloqueo → al socio',
         (SELECT pg_get_functiondef(oid) LIKE '%No asististe a tu clase%'
            FROM pg_proc WHERE proname = 'marcar_no_shows' LIMIT 1)
)
SELECT CASE WHEN ok THEN '✅' ELSE '❌' END AS estado, prueba
FROM checks
ORDER BY ok, prueba;
