-- ============================================================================
-- Sprint Reportes Avanzados · PARTE 1 — Tracking de cambios de status
-- ============================================================================
-- Hoy no se registra cuándo un miembro cambia de status (activo→cancelado,
-- etc.). Sin eso no hay churn ni retención reales. Esta migración crea la
-- tabla de auditoría que lo resuelve.
--
-- DECISIÓN: Opción A — tabla de historial completo (no una columna
-- `status_changed_at`). Razones:
--   - Churn por período necesita saber QUÉ pasó DENTRO de un rango, no solo
--     el último cambio. Una columna solo guarda el último → imposible
--     reconstruir churn de meses pasados.
--   - Retención por cohorte necesita reconstruir el status de cada miembro
--     en fechas arbitrarias (M+1, M+2, M+3). Eso requiere el historial.
--   - El costo es una tabla append-only barata, con índices por
--     (tenant, changed_at) y (usuario, changed_at).
--
-- DISEÑO:
--   - status_anterior / status_nuevo son `text` SIN CHECK: el historial debe
--     tolerar cualquier valor de status presente o futuro (ej. 'revocado',
--     que el código usa pero no está en el CHECK de usuarios) sin romper.
--   - Trigger AFTER INSERT  → entrada inicial (alta): status_anterior NULL.
--   - Trigger AFTER UPDATE  → SOLO si el status cambió (WHEN ...).
--   - Backfill: una entrada inicial por cada usuario existente, con
--     changed_at = created_at. Así el historial es uniforme — todo usuario
--     (viejo o nuevo) tiene una entrada de alta.
-- ============================================================================

-- ============================================================================
-- A) TABLA usuario_status_historial
-- ============================================================================

CREATE TABLE IF NOT EXISTS usuario_status_historial (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,

  -- text sin CHECK: tolerante a status presentes/futuros sin migración.
  status_anterior text,            -- NULL en la entrada inicial (alta)
  status_nuevo text NOT NULL,

  changed_at timestamptz NOT NULL DEFAULT now(),
  -- Quién hizo el cambio (usuarios.id). NULL si fue sin sesión auth
  -- (SQL Editor, service_role, backfill).
  changed_by uuid REFERENCES usuarios(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ush_tenant_changed
  ON usuario_status_historial (tenant_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_ush_usuario_changed
  ON usuario_status_historial (usuario_id, changed_at);

COMMENT ON TABLE usuario_status_historial IS
  'Sprint Reportes Avanzados: auditoría append-only de cambios de status de usuarios. Fuente de verdad para churn y retención por cohorte. Una entrada inicial (status_anterior NULL) por alta + una por cada cambio.';

ALTER TABLE usuario_status_historial ENABLE ROW LEVEL SECURITY;

-- RLS: solo el admin del tenant lee. Las escrituras van únicamente por el
-- trigger SECURITY DEFINER (sin policy de INSERT/UPDATE/DELETE).
DROP POLICY IF EXISTS ush_admin_read ON usuario_status_historial;
CREATE POLICY ush_admin_read ON usuario_status_historial
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());

-- ============================================================================
-- B) TRIGGER FUNCTION — registra alta + cambios de status
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_registrar_status_usuario()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Entrada inicial de alta: status_anterior NULL, fechada en created_at.
    INSERT INTO usuario_status_historial
      (tenant_id, usuario_id, status_anterior, status_nuevo, changed_at, changed_by)
    VALUES
      (NEW.tenant_id, NEW.id, NULL, NEW.status, NEW.created_at, get_my_user_id());
  ELSE
    -- UPDATE: el WHEN del trigger ya garantizó que el status cambió.
    INSERT INTO usuario_status_historial
      (tenant_id, usuario_id, status_anterior, status_nuevo, changed_at, changed_by)
    VALUES
      (NEW.tenant_id, NEW.id, OLD.status, NEW.status, now(), get_my_user_id());
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION trg_registrar_status_usuario() FROM PUBLIC;

COMMENT ON FUNCTION trg_registrar_status_usuario() IS
  'Registra en usuario_status_historial el alta de un usuario (INSERT) y cada cambio de status (UPDATE).';

-- ============================================================================
-- C) TRIGGERS en usuarios
-- ============================================================================

DROP TRIGGER IF EXISTS usuarios_status_historial_insert ON usuarios;
CREATE TRIGGER usuarios_status_historial_insert
  AFTER INSERT ON usuarios
  FOR EACH ROW
  EXECUTE FUNCTION trg_registrar_status_usuario();

-- SOLO cambios de status: el WHEN evita registrar updates de nombre/teléfono/etc.
DROP TRIGGER IF EXISTS usuarios_status_historial_update ON usuarios;
CREATE TRIGGER usuarios_status_historial_update
  AFTER UPDATE ON usuarios
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION trg_registrar_status_usuario();

-- ============================================================================
-- D) BACKFILL — entrada inicial para usuarios existentes
-- ============================================================================
-- Una entrada de alta por cada usuario que aún no tenga historial, fechada en
-- su created_at. Idempotente (WHERE NOT EXISTS): re-correr la migración no
-- duplica nada.
-- ============================================================================

DO $$
DECLARE
  v_backfilled integer := 0;
BEGIN
  INSERT INTO usuario_status_historial
    (tenant_id, usuario_id, status_anterior, status_nuevo, changed_at, changed_by)
  SELECT u.tenant_id, u.id, NULL, u.status, u.created_at, NULL
  FROM usuarios u
  WHERE NOT EXISTS (
    SELECT 1 FROM usuario_status_historial h WHERE h.usuario_id = u.id
  );
  GET DIAGNOSTICS v_backfilled = ROW_COUNT;
  RAISE NOTICE 'Backfill usuario_status_historial: % entradas iniciales creadas.', v_backfilled;
END $$;

-- ============================================================================
-- Fin migración PARTE 1
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migración usuario_status_historial OK: tabla + función + 2 triggers + backfill.';
END $$;
