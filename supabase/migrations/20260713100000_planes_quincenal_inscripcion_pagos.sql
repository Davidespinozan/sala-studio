-- ============================================================================
-- ETAPA 1/3 — ESQUEMA: planes quincenales, inscripción, invitados por periodo
--             y registro real de cobros.
-- ----------------------------------------------------------------------------
-- Esta migración es ADITIVA: agrega columnas y tablas, no reescribe ninguna
-- función. Nada del comportamiento actual cambia hasta la etapa 2 (RPCs).
--
-- 1) tiers.periodo acepta 'quincenal' (15 días). La vigencia real la manda
--    duracion_dias — 'periodo' queda como etiqueta comercial + ciclo de Stripe.
-- 2) tiers.inscripcion_centavos — cuota única de alta. 0 = sin inscripción.
-- 3) tiers.invitados_por_periodo — BOLSA de pases de invitado por periodo de la
--    membresía. Reemplaza a reglas->>'max_invitados', que era un techo POR CLASE
--    (un socio con techo 2 podía traer 2 invitados a cada una de las 20 clases
--    del mes = 40 pases). 0 = el plan no incluye invitados.
-- 4) usuarios.inscripcion_pagada_at — la inscripción se cobra UNA sola vez por
--    socio (decisión de David): esta marca evita recobrarla al renovar o cambiar
--    de plan.
-- 5) tabla `pagos` — hoy el dinero es invisible: un cobro en efectivo en
--    recepción no deja registro del monto, solo una línea de bitácora con texto
--    libre. Ledger append-only de cobros reales (plan, inscripción, paquete).
-- ============================================================================

-- ── 1) periodo: agregar 'quincenal' ─────────────────────────────────────────
ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_periodo_check;
ALTER TABLE tiers
  ADD CONSTRAINT tiers_periodo_check
  CHECK (periodo IN ('quincenal', 'mensual', 'anual'));

-- ── 2) inscripción (cuota única de alta) ────────────────────────────────────
ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS inscripcion_centavos integer NOT NULL DEFAULT 0;

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_inscripcion_no_neg;
ALTER TABLE tiers
  ADD CONSTRAINT tiers_inscripcion_no_neg CHECK (inscripcion_centavos >= 0);

COMMENT ON COLUMN tiers.inscripcion_centavos IS
  'Cuota ÚNICA de inscripción al dar de alta al socio en este plan. 0 = sin inscripción. Se cobra una sola vez por socio (ver usuarios.inscripcion_pagada_at).';

-- ── 3) invitados: bolsa por periodo (no techo por clase) ────────────────────
ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS invitados_por_periodo integer NOT NULL DEFAULT 0;

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_invitados_no_neg;
ALTER TABLE tiers
  ADD CONSTRAINT tiers_invitados_no_neg CHECK (invitados_por_periodo >= 0);

COMMENT ON COLUMN tiers.invitados_por_periodo IS
  'Pases de invitado incluidos en CADA periodo de la membresía (ej. 10 al mes; en un plan quincenal, 10 por quincena). 0 = el plan no permite invitados. Reemplaza a reglas->>max_invitados, que era por clase.';

-- Semilla desde el valor viejo (era "por clase", así que como bolsa mensual
-- queda conservador: el admin lo reconfigura con los números reales).
UPDATE tiers
SET invitados_por_periodo = COALESCE((reglas->>'max_invitados')::int, 0)
WHERE invitados_por_periodo = 0
  AND reglas ? 'max_invitados';

-- ── 4) marca de inscripción pagada (una vez por socio) ──────────────────────
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS inscripcion_pagada_at timestamptz;

COMMENT ON COLUMN usuarios.inscripcion_pagada_at IS
  'Cuándo pagó la inscripción. NOT NULL = ya la pagó y no se le vuelve a cobrar (ni al renovar, ni al cambiar de plan).';

-- ── 5) pagos: ledger append-only de cobros reales ───────────────────────────
CREATE TABLE IF NOT EXISTS pagos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sucursal_id uuid REFERENCES sucursales(id) ON DELETE SET NULL,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  membresia_id uuid REFERENCES membresias(id) ON DELETE SET NULL,
  tier_id uuid REFERENCES tiers(id) ON DELETE SET NULL,

  concepto text NOT NULL CHECK (concepto IN ('plan', 'inscripcion', 'paquete', 'otro')),
  monto_centavos integer NOT NULL CHECK (monto_centavos >= 0),
  moneda text NOT NULL DEFAULT 'MXN',
  metodo text NOT NULL CHECK (metodo IN ('efectivo', 'tarjeta', 'transferencia', 'stripe', 'cortesia')),

  -- id de Stripe (invoice/payment_intent) o folio del comprobante. Sirve de
  -- llave de idempotencia: el webhook puede reintentar sin duplicar el cobro.
  referencia text,
  notas text,
  -- Staff que cobró. NULL = cobro online (Stripe), sin persona detrás.
  cobrado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pagos IS
  'Ledger append-only de DINERO cobrado al socio (plan, inscripción, paquete), en efectivo o por Stripe. Solo lo escriben RPCs SECURITY DEFINER: no hay policy de INSERT para authenticated.';

CREATE INDEX IF NOT EXISTS pagos_tenant_fecha_idx  ON pagos (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pagos_usuario_fecha_idx ON pagos (usuario_id, created_at DESC);

-- Un cobro de Stripe se registra UNA sola vez aunque el webhook reintente.
CREATE UNIQUE INDEX IF NOT EXISTS pagos_referencia_unica
  ON pagos (tenant_id, referencia)
  WHERE referencia IS NOT NULL;

-- Append-only: el dinero no se edita ni se borra (se corrige con otro asiento).
CREATE OR REPLACE FUNCTION trg_pagos_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PAGOS_APPEND_ONLY: un pago no se edita ni se borra; registrá un asiento de corrección';
END;
$$;

DROP TRIGGER IF EXISTS pagos_no_update ON pagos;
CREATE TRIGGER pagos_no_update
  BEFORE UPDATE OR DELETE ON pagos
  FOR EACH ROW EXECUTE FUNCTION trg_pagos_append_only();

ALTER TABLE pagos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pagos_read_self ON pagos;
CREATE POLICY pagos_read_self ON pagos
  FOR SELECT TO authenticated
  USING (usuario_id = get_my_user_id());

DROP POLICY IF EXISTS pagos_read_staff ON pagos;
CREATE POLICY pagos_read_staff ON pagos
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- ── 6) helper: pases de invitado disponibles en el periodo vigente ──────────
-- Fuente de verdad única para la UI del socio y para el RPC de reserva.
-- Cuenta los invitados YA usados en clases del periodo actual: como solo suma
-- reservas vivas, cancelar una reserva devuelve los pases automáticamente.
CREATE OR REPLACE FUNCTION invitados_disponibles(p_usuario_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_incluidos integer := 0;
  v_usados integer := 0;
  v_inicio timestamptz;
  v_fin timestamptz;
BEGIN
  -- Un socio solo puede consultarse a sí mismo; staff puede consultar a los suyos.
  IF p_usuario_id <> get_my_user_id() AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  SELECT COALESCE(t.invitados_por_periodo, 0), m.periodo_actual_inicio, m.periodo_actual_fin
  INTO v_incluidos, v_inicio, v_fin
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('activa', 'trialing', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF NOT FOUND OR COALESCE(v_incluidos, 0) = 0 THEN
    RETURN jsonb_build_object('incluidos', 0, 'usados', 0, 'disponibles', 0);
  END IF;

  -- Planes de créditos puros no tienen periodo (no vencen) → ventana = mes actual.
  v_inicio := COALESCE(v_inicio, date_trunc('month', now()));
  v_fin    := COALESCE(v_fin, v_inicio + interval '1 month');

  SELECT COALESCE(SUM(r.invitados_count), 0)
  INTO v_usados
  FROM reservas r
  JOIN clases c ON c.id = r.clase_id
  WHERE r.usuario_id = p_usuario_id
    -- 'no_show' cuenta como usado: el pase se quema igual que el crédito si el
    -- socio no se presentó. Solo 'cancelada' devuelve el pase.
    AND r.status IN ('confirmada', 'completada', 'no_show')
    AND c.fecha >= v_inicio::date
    AND c.fecha <  v_fin::date;

  RETURN jsonb_build_object(
    'incluidos', v_incluidos,
    'usados', v_usados,
    'disponibles', GREATEST(v_incluidos - v_usados, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION invitados_disponibles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitados_disponibles(uuid) TO authenticated;

-- ============================================================================
-- SELF-TEST — devuelve TABLA (el editor de Supabase esconde los NOTICE).
-- ============================================================================
WITH checks AS (
  SELECT 'tiers.periodo acepta quincenal' AS prueba,
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'tiers_periodo_check'
             AND pg_get_constraintdef(oid) LIKE '%quincenal%'
         ) AS ok
  UNION ALL
  SELECT 'tiers.inscripcion_centavos',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'tiers' AND column_name = 'inscripcion_centavos')
  UNION ALL
  SELECT 'tiers.invitados_por_periodo',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'tiers' AND column_name = 'invitados_por_periodo')
  UNION ALL
  SELECT 'usuarios.inscripcion_pagada_at',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'usuarios' AND column_name = 'inscripcion_pagada_at')
  UNION ALL
  SELECT 'tabla pagos',
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pagos')
  UNION ALL
  SELECT 'pagos con RLS activo',
         COALESCE((SELECT relrowsecurity FROM pg_class WHERE relname = 'pagos'), false)
  UNION ALL
  SELECT 'pagos sin policy de INSERT (solo RPCs escriben)',
         NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE tablename = 'pagos' AND cmd = 'INSERT')
  UNION ALL
  SELECT 'función invitados_disponibles',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'invitados_disponibles')
)
SELECT
  CASE WHEN ok THEN '✅' ELSE '❌' END AS estado,
  prueba,
  (SELECT count(*) FROM tiers WHERE invitados_por_periodo > 0) AS tiers_con_invitados,
  (SELECT count(*) FROM tiers) AS tiers_totales
FROM checks
ORDER BY ok, prueba;
