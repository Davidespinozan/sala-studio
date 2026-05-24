-- ============================================================================
-- Sprint Membresías Prepago — Fase 1: schema aditivo para 3 tipos de plan
-- ============================================================================
-- Hoy `tiers` solo soporta vigencia por tiempo (periodo: mensual/anual) y
-- `membresias` no tiene noción de créditos. Esta migración AGREGA lo que falta
-- para los 3 tipos sin tocar nada existente:
--
--   tiempo     — vigencia por días (diario/semanal/mensual/anual/N días)
--   creditos   — paquete de N clases (puede o no vencer)
--   hibrido    — N clases que vencen en X días
--
-- TODO ES ADITIVO:
--   - Columnas nuevas en tiers (con DEFAULT o NULL → cero rows rotas).
--   - Columna nueva en membresias (NULL → cero rows rotas).
--   - CHECK de membresias.status: se reemplaza por uno MÁS amplio (incluye
--     'congelada'); todos los valores actuales siguen siendo válidos.
--   - Tabla nueva membresia_movimientos (ledger append-only).
--
-- LA COLUMNA `tiers.periodo` SE MANTIENE — la migración de datos la traduce
-- a `duracion_dias`, pero no la borra. Se removerá en una fase futura cuando
-- el código nuevo deje de leerla.
--
-- NO TOCA LA LÓGICA: ni reservar_clase_atomic ni cancelar_reserva_atomic se
-- modifican acá. Eso es Fase 2/3.
-- ============================================================================

-- ============================================================================
-- A) tiers — tipo + duracion_dias + clases_incluidas
-- ============================================================================

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'tiempo'
    CHECK (tipo IN ('tiempo', 'creditos', 'hibrido'));

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS duracion_dias integer;

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS clases_incluidas integer;

COMMENT ON COLUMN tiers.tipo IS
  'Tipo de plan: tiempo (vigencia por días), creditos (paquete de N clases), hibrido (N clases que vencen en X días).';
COMMENT ON COLUMN tiers.duracion_dias IS
  'Días de vigencia desde el alta. NULL = sin vencimiento (créditos puros que no caducan). Diario=1, Semanal=7, Mensual=30, Anual=365, o N arbitrario.';
COMMENT ON COLUMN tiers.clases_incluidas IS
  'Cantidad de clases incluidas. NULL = ilimitado (tiempo puro). N = paquete (créditos/híbrido).';

-- ----------------------------------------------------------------------------
-- Migración de datos: tiers existentes (todos son tiempo)
-- ----------------------------------------------------------------------------
-- Los tiers actuales tienen periodo IN ('mensual','anual') y se asumen como
-- planes de TIEMPO con clases ilimitadas. Sembrar duracion_dias acorde para
-- que el modelo nuevo quede coherente con el viejo. tipo ya quedó 'tiempo'
-- por el DEFAULT al hacer ADD COLUMN.

UPDATE tiers
SET duracion_dias = CASE periodo
                      WHEN 'mensual' THEN 30
                      WHEN 'anual'   THEN 365
                    END
WHERE duracion_dias IS NULL
  AND periodo IN ('mensual', 'anual');
-- clases_incluidas queda NULL (= ilimitado), que es lo correcto para los
-- planes actuales (Básica/Pro/Drop-In/Ilimitado).

-- ============================================================================
-- B) membresias — creditos_restantes + 'congelada' en status
-- ============================================================================

ALTER TABLE membresias
  ADD COLUMN IF NOT EXISTS creditos_restantes integer;

COMMENT ON COLUMN membresias.creditos_restantes IS
  'Saldo de créditos del miembro. NULL si el tier es tiempo puro (ilimitado). N para créditos/híbrido; cada reserva resta 1, cada devolución suma 1.';

-- Status: agregar 'congelada' al CHECK. Versión defensiva — el constraint
-- existente se encuentra por INTROSPECCIÓN: busca en pg_constraint el CHECK
-- de membresias cuyo `conkey` es exactamente la columna `status`. Robusto
-- contra:
--   - cualquier nombre que tenga el constraint (hardcodeado, renombrado, etc.)
--   - cómo Postgres formatea el texto (internamente reescribe `IN (...)` a
--     `= ANY (ARRAY[...])`, así que un ILIKE sobre el texto sería frágil)
-- Si no encuentra nada, no rompe (sigue de largo y agrega el nuevo).
DO $$
DECLARE
  v_status_attnum smallint;
  v_name text;
BEGIN
  SELECT attnum INTO v_status_attnum
  FROM pg_attribute
  WHERE attrelid = 'membresias'::regclass
    AND attname = 'status'
    AND NOT attisdropped;

  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'membresias'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[v_status_attnum]::int2[]
  LIMIT 1;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE membresias DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

ALTER TABLE membresias ADD CONSTRAINT membresias_status_check
  CHECK (status IN (
    'pendiente',
    'trialing',
    'activa',
    'past_due',
    'cancelada',
    'expirada',
    'congelada'   -- ← NUEVO: pausa explícita (la lógica viene en Fase 2)
  ));

-- ============================================================================
-- C) membresia_movimientos — ledger append-only de débitos/créditos
-- ============================================================================
-- Cada movimiento de saldo (alta del paquete, débito por reserva, devolución
-- por cancelación a tiempo, expiración, ajuste manual) deja una fila acá.
-- Append-only: ningún cliente lo edita ni borra; el cascade desde membresias
-- es el único DELETE posible.

CREATE TABLE IF NOT EXISTS membresia_movimientos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membresia_id uuid NOT NULL REFERENCES membresias(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Tipo de movimiento
  tipo text NOT NULL CHECK (tipo IN (
    'alta',         -- carga inicial del paquete (creditos_total al activar)
    'debito',       -- reserva consumió 1 crédito (delta = -1)
    'devolucion',   -- cancelación a tiempo devolvió 1 crédito (delta = +1)
    'expiracion',   -- vencimiento del paquete; los créditos quedan en 0
    'ajuste'        -- ajuste manual del admin (regalar/quitar créditos)
  )),

  -- Variación del saldo: negativo (débito) o positivo (alta/devolución/ajuste+).
  -- 0 está permitido (ej. expiración informativa de un paquete ya en 0).
  delta_creditos integer NOT NULL,

  -- Vínculo opcional a la reserva que motivó el movimiento (débito o devolución).
  reserva_id uuid REFERENCES reservas(id) ON DELETE SET NULL,

  motivo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Quién lo hizo (usuario admin/recep si fue manual; NULL si lo escribió un
  -- RPC SECURITY DEFINER sin contexto de sesión auth.uid()).
  created_by uuid REFERENCES usuarios(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_membresia_mov_membresia_created
  ON membresia_movimientos (membresia_id, created_at);
CREATE INDEX IF NOT EXISTS idx_membresia_mov_tenant_created
  ON membresia_movimientos (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_membresia_mov_reserva
  ON membresia_movimientos (reserva_id) WHERE reserva_id IS NOT NULL;

ALTER TABLE membresia_movimientos ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE membresia_movimientos IS
  'Ledger append-only de movimientos de crédito de cada membresía. Solo se escribe vía RPCs SECURITY DEFINER; nunca por clientes. UPDATE bloqueado por trigger; DELETE solo en cascade desde membresias.';

-- ----------------------------------------------------------------------------
-- RLS — patrón consistente con membresias/reservas:
--   _read_self  : el dueño de la membresía ve sus movimientos
--   _read_staff : admin + recepción del tenant ven todos los del tenant
--   NO hay policy de escritura: clientes no pueden insertar/update/delete.
--   Las inserciones reales las hacen RPCs SECURITY DEFINER (bypassean RLS).
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS membresia_mov_read_self ON membresia_movimientos;
CREATE POLICY membresia_mov_read_self ON membresia_movimientos
  FOR SELECT
  TO authenticated
  USING (
    membresia_id IN (
      SELECT m.id FROM membresias m WHERE m.usuario_id = get_my_user_id()
    )
  );

DROP POLICY IF EXISTS membresia_mov_read_staff ON membresia_movimientos;
CREATE POLICY membresia_mov_read_staff ON membresia_movimientos
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- ----------------------------------------------------------------------------
-- Append-only: bloquear UPDATE. (DELETE no se bloquea por trigger porque el
-- cascade desde membresias debe poder limpiar; las policies ya impiden DELETE
-- de clientes — no hay policy de DELETE, así que clientes no pueden borrar.)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_membresia_mov_no_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'membresia_movimientos es append-only: UPDATE no permitido';
END;
$$;

DROP TRIGGER IF EXISTS membresia_mov_no_update ON membresia_movimientos;
CREATE TRIGGER membresia_mov_no_update
  BEFORE UPDATE ON membresia_movimientos
  FOR EACH ROW
  EXECUTE FUNCTION trg_membresia_mov_no_update();

-- ============================================================================
-- D) VERIFICACIÓN
-- ============================================================================

DO $$
DECLARE
  v_tiers integer;
  v_tiers_sin_duracion integer;
  v_membresias integer;
BEGIN
  SELECT count(*) INTO v_tiers FROM tiers;
  SELECT count(*) INTO v_tiers_sin_duracion FROM tiers WHERE duracion_dias IS NULL;
  SELECT count(*) INTO v_membresias FROM membresias;

  RAISE NOTICE 'Schema membresías prepago OK.';
  RAISE NOTICE '  tiers totales: % (con duracion_dias=NULL: %; deberían ser solo los que tengan periodo distinto de mensual/anual)',
    v_tiers, v_tiers_sin_duracion;
  RAISE NOTICE '  membresias totales: % (creditos_restantes queda NULL en todas — coherente con tipo=tiempo)',
    v_membresias;
END $$;
