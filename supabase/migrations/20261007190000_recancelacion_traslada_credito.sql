-- ════════════════════════════════════════════════════════════════════════════
-- RE-RESERVAR LA MISMA CLASE TRAS CANCELACIÓN TARDÍA → TRASLADA EL CRÉDITO
-- ────────────────────────────────────────────────────────────────────────────
-- Problema (caso Angie Meza / The Core, 5-oct):
--   Socia cancela tarde (dentro de cancelacion_min_horas) → el crédito NO se
--   devuelve (penalización correcta). Minutos después recepción la vuelve a
--   anotar en LA MISMA clase (walk-in) → se debita OTRO crédito. Resultado: 2
--   créditos por una sola clase a la que sí asistió. Las multas ya tenían la
--   regla "re-reservar el mismo slot no cobra"; los créditos no.
--
-- Regla nueva:
--   Al insertarse un 'debito' por una reserva, si el MISMO socio tiene en la
--   MISMA clase una reserva cancelada cuyo débito quedó retenido (neto < 0 en
--   el ledger, sobre la MISMA membresía), ese crédito retenido se traslada:
--     · 'devolucion' +N sobre la reserva vieja (evidencia por reserva intacta)
--     · creditos_restantes += N
--   Neto para el socio: la clase cuesta 1 crédito, no 2.
--
-- Por qué un trigger y no tocar los RPC:
--   El débito sale de varios RPC endurecidos (reservar_clase_atomic,
--   recepcion_crear_reserva, promoción de lista de espera). El trigger cubre
--   a todos sin reabrirlos.
--
-- Locks / concurrencia:
--   El trigger corre DENTRO de la transacción del débito, que ya tiene la fila
--   de la membresía bloqueada (acaba de hacer UPDATE creditos_restantes). No
--   pide locks nuevos (en particular NO bloquea la fila de la reserva vieja →
--   no invierte el orden R → X → M). Dos re-reservas concurrentes del mismo
--   socio se serializan en ese lock de M; la segunda ve la devolución de la
--   primera (neto 0) y no traslada dos veces.
--
-- Interacción con admin_marcar_asistencia (restauración):
--   Si luego alguien "restaura" la reserva vieja a completada, ese RPC ve la
--   devolución en el ledger y re-debita — correcto: el crédito ya se usó en la
--   reserva nueva.
--
-- Efecto colateral conocido: el RPC que reserva devuelve creditos_restantes
-- calculado ANTES del trigger (muestra 1 menos). La app refresca el saldo
-- desde la base, así que solo dura hasta el siguiente refresh.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._trasladar_credito_recancelacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_nueva reservas;
  v_pend integer := -NEW.delta_creditos;
  v_total integer := 0;
  v_neto integer;
  v_tr integer;
  r record;
BEGIN
  -- Solo planes por créditos (los ilimitados tienen creditos_restantes NULL).
  IF NOT EXISTS (SELECT 1 FROM membresias WHERE id = NEW.membresia_id AND creditos_restantes IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_nueva FROM reservas WHERE id = NEW.reserva_id;
  IF NOT FOUND OR v_nueva.clase_id IS NULL THEN
    RETURN NULL;
  END IF;

  FOR r IN
    SELECT id, folio
    FROM reservas
    WHERE usuario_id = v_nueva.usuario_id
      AND clase_id = v_nueva.clase_id
      AND id <> v_nueva.id
      AND status IN ('cancelada', 'cancelada_admin')
    ORDER BY cancelada_at DESC NULLS LAST, created_at DESC
  LOOP
    SELECT COALESCE(SUM(delta_creditos), 0) INTO v_neto
    FROM membresia_movimientos
    WHERE reserva_id = r.id AND membresia_id = NEW.membresia_id;

    CONTINUE WHEN v_neto >= 0;

    v_tr := LEAST(-v_neto, v_pend);
    INSERT INTO membresia_movimientos
      (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by)
    VALUES
      (NEW.membresia_id, NEW.tenant_id, 'devolucion', v_tr, r.id,
       'crédito trasladado a reserva ' || v_nueva.folio
         || ' (re-reserva de la misma clase tras cancelación tardía de ' || r.folio || ')',
       NEW.created_by);

    v_total := v_total + v_tr;
    v_pend := v_pend - v_tr;
    EXIT WHEN v_pend <= 0;
  END LOOP;

  IF v_total > 0 THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes + v_total
    WHERE id = NEW.membresia_id;
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._trasladar_credito_recancelacion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS membresia_mov_trasladar_recancelacion ON membresia_movimientos;
CREATE TRIGGER membresia_mov_trasladar_recancelacion
  AFTER INSERT ON membresia_movimientos
  FOR EACH ROW
  WHEN (NEW.tipo = 'debito' AND NEW.reserva_id IS NOT NULL AND NEW.delta_creditos < 0)
  EXECUTE FUNCTION public._trasladar_credito_recancelacion();

-- ── Backfill: casos históricos. En prod al 7-oct hay 3 pares, pero los 2 de
--    numawellness (SAL-000958, SAL-001699) son planes ilimitados (créditos NULL)
--    → no perdieron nada y se excluyen. Queda solo thecorestudio SAL-000094
--    (Angie Meza, 3 → 4). Solo membresías activas por créditos.
--    Idempotente: después de correr, la reserva vieja queda con neto 0 y ya no
--    califica. Devuelve TABLA con lo que tocó.
WITH neto AS (
  SELECT reserva_id, membresia_id, SUM(delta_creditos)::integer AS neto
  FROM membresia_movimientos
  WHERE reserva_id IS NOT NULL
  GROUP BY 1, 2
),
casos AS (
  SELECT DISTINCT ON (vieja.id)
    vieja.id AS vieja_id, vieja.folio AS vieja_folio,
    nueva.folio AS nueva_folio,
    mem.id AS membresia_id, mem.tenant_id,
    LEAST(-nv.neto, -nn.neto) AS creditos
  FROM reservas vieja
  JOIN neto nv ON nv.reserva_id = vieja.id AND nv.neto < 0
  JOIN reservas nueva
    ON nueva.usuario_id = vieja.usuario_id
   AND nueva.clase_id = vieja.clase_id
   AND nueva.id <> vieja.id
   AND nueva.created_at > vieja.cancelada_at
   AND nueva.status NOT IN ('cancelada', 'cancelada_admin')
  JOIN neto nn ON nn.reserva_id = nueva.id AND nn.membresia_id = nv.membresia_id AND nn.neto < 0
  JOIN membresias mem ON mem.id = nv.membresia_id AND mem.status = 'activa'
                   AND mem.creditos_restantes IS NOT NULL
  WHERE vieja.status IN ('cancelada', 'cancelada_admin')
    AND vieja.clase_id IS NOT NULL
  ORDER BY vieja.id, nueva.created_at
),
ins AS (
  INSERT INTO membresia_movimientos
    (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by)
  SELECT membresia_id, tenant_id, 'devolucion', creditos, vieja_id,
         'crédito trasladado a reserva ' || nueva_folio
           || ' (re-reserva de la misma clase tras cancelación tardía de ' || vieja_folio
           || ') — corrección histórica',
         NULL
  FROM casos
  RETURNING membresia_id, delta_creditos
),
upd AS (
  UPDATE membresias m
  SET creditos_restantes = m.creditos_restantes + s.total
  FROM (SELECT membresia_id, SUM(delta_creditos) AS total FROM ins GROUP BY 1) s
  WHERE m.id = s.membresia_id
  RETURNING m.id, m.creditos_restantes
)
SELECT t.slug, u.nombre, c.vieja_folio, c.nueva_folio, c.creditos AS devueltos,
       upd.creditos_restantes AS saldo_nuevo
FROM casos c
JOIN upd ON upd.id = c.membresia_id
JOIN tenants t ON t.id = c.tenant_id
JOIN membresias m ON m.id = c.membresia_id
JOIN usuarios u ON u.id = m.usuario_id
ORDER BY t.slug, c.vieja_folio;
