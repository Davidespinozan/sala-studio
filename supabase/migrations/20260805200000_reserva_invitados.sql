-- ============================================================================
-- Invitados con IDENTIDAD (no solo un número)
-- ============================================================================
-- Hasta hoy un invitado era solo `reservas.invitados_count` (un entero): se sabía
-- CUÁNTOS venían, no QUIÉNES. Se perdía lo valioso — un invitado es un prospecto
-- (ya fue al gym; se puede convertir en socio). Esta tabla guarda la identidad de
-- cada invitado ligada a la reserva, sin tocar la ruta de reservar: la reserva se
-- crea igual y los invitados se insertan aparte.
--
-- `invitados_count` sigue siendo la fuente para cupo y bolsa de pases; esta tabla
-- solo agrega identidades (nombre/teléfono/email).
-- ============================================================================

CREATE TABLE IF NOT EXISTS reserva_invitados (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  reserva_id  uuid NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  telefono    text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reserva_invitados_tenant_fecha_idx ON reserva_invitados (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reserva_invitados_reserva_idx      ON reserva_invitados (reserva_id);

COMMENT ON TABLE reserva_invitados IS
  'Identidad de cada invitado de una reserva (prospecto). invitados_count sigue siendo el conteo para cupo/bolsa; esto agrega nombre/teléfono/email.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE reserva_invitados ENABLE ROW LEVEL SECURITY;

-- Lectura: staff del tenant (recepción/admin), o el socio dueño de la reserva.
DROP POLICY IF EXISTS reserva_invitados_select ON reserva_invitados;
CREATE POLICY reserva_invitados_select ON reserva_invitados
  FOR SELECT TO authenticated
  USING (
    tenant_id = get_my_tenant_id()
    AND (
      is_recepcionista()
      OR reserva_id IN (SELECT id FROM reservas WHERE usuario_id = get_my_user_id())
    )
  );

-- Inserción: el socio dueño de la reserva, o staff. Siempre atado a mi tenant.
DROP POLICY IF EXISTS reserva_invitados_insert ON reserva_invitados;
CREATE POLICY reserva_invitados_insert ON reserva_invitados
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = get_my_tenant_id()
    AND reserva_id IN (SELECT id FROM reservas WHERE tenant_id = get_my_tenant_id())
    AND (
      is_recepcionista()
      OR reserva_id IN (SELECT id FROM reservas WHERE usuario_id = get_my_user_id())
    )
  );

-- Corrección / borrado: solo staff del tenant.
DROP POLICY IF EXISTS reserva_invitados_update ON reserva_invitados;
CREATE POLICY reserva_invitados_update ON reserva_invitados
  FOR UPDATE TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

DROP POLICY IF EXISTS reserva_invitados_delete ON reserva_invitados;
CREATE POLICY reserva_invitados_delete ON reserva_invitados
  FOR DELETE TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- ── Verificación (devuelve tabla) ────────────────────────────────────────────
SELECT
  to_regclass('public.reserva_invitados') IS NOT NULL   AS tabla_creada,
  (SELECT count(*) FROM pg_policies
     WHERE tablename = 'reserva_invitados')              AS policies_tabla;
