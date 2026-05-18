-- ============================================================================
-- RESERVAS
-- ============================================================================
-- Cada reserva es 1 slot de tiempo en 1 recurso por 1 miembro.
-- Para EKKO (recurso individual, cupos=1): UNIQUE (tenant, recurso, slot_inicio).
-- Para yoga/cycling (sala grupal, cupos=N): N filas con mismo slot_inicio.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reservas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recurso_id uuid NOT NULL REFERENCES recursos(id) ON DELETE RESTRICT,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,

  -- Tiempos
  slot_inicio timestamptz NOT NULL,
  slot_fin timestamptz NOT NULL,
  duracion_min integer NOT NULL,

  -- Folio legible
  folio text NOT NULL,                           -- 'EKK-000123'

  -- Estado
  status text NOT NULL DEFAULT 'confirmada'
    CHECK (status IN ('confirmada', 'cancelada', 'completada', 'no_show')),

  -- Check-in
  qr_token_hash text,                            -- hash del JWT firmado
  check_in_at timestamptz,
  check_in_by uuid REFERENCES usuarios(id),      -- recepcionista que validó

  -- Cancelación
  cancelada_at timestamptz,
  cancelada_motivo text,

  -- Invitados (snapshot al momento de reservar)
  invitados_count integer NOT NULL DEFAULT 0,

  -- Metadata
  notas text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (slot_fin > slot_inicio),
  CHECK (duracion_min > 0)
);

CREATE INDEX IF NOT EXISTS reservas_tenant_idx ON reservas (tenant_id);
CREATE INDEX IF NOT EXISTS reservas_usuario_idx ON reservas (usuario_id);
CREATE INDEX IF NOT EXISTS reservas_recurso_slot_idx ON reservas (recurso_id, slot_inicio);
CREATE INDEX IF NOT EXISTS reservas_slot_inicio_idx ON reservas (tenant_id, slot_inicio);
CREATE INDEX IF NOT EXISTS reservas_status_idx ON reservas (tenant_id, status);
CREATE INDEX IF NOT EXISTS reservas_folio_idx ON reservas (tenant_id, folio);

-- Un solo activo por (recurso, slot_inicio) cuando cupos=1.
-- Si en futuro recurso.cupos > 1, esto se relaja con un check más sofisticado.
CREATE UNIQUE INDEX IF NOT EXISTS reservas_unique_slot_per_recurso
  ON reservas (recurso_id, slot_inicio)
  WHERE status IN ('confirmada', 'completada');

-- Secuencia para folios
CREATE SEQUENCE IF NOT EXISTS reservas_folio_seq START 1;

DROP TRIGGER IF EXISTS reservas_set_updated_at ON reservas;
CREATE TRIGGER reservas_set_updated_at
  BEFORE UPDATE ON reservas
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE reservas ENABLE ROW LEVEL SECURITY;
