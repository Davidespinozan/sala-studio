-- ============================================================================
-- WAVE 5 · B — Cache derivado de membresía (sincronización por trigger)
-- ----------------------------------------------------------------------------
-- D-W5-4: usuarios.membresia_activa_id / membresia_tier se MANTIENEN pero como
-- CACHE DERIVADO de membresias. Un trigger AFTER I/U/D en membresias recomputa
-- el cache del socio afectado desde la membresía ACTIVA canónica (<=1 por el
-- índice único), sin importar la ruta de escritura (RPC, cron, Stripe directo,
-- admin directo). Esto cierra RC-05-D (Stripe subscription.deleted/payment_failed
-- y cancel self-serve dejaban el cache colgado apuntando a una fila no-activa).
--
-- Semántica del cache = la de HOY (membresía status='activa', o NULL): esta pieza
-- NO cambia qué significa el pointer ni qué leen los consumidores (eso es W5-D).
-- Solo lo hace robusto/auto-sincronizado. "vigente" sigue siendo el predicado
-- canónico (W5-A), no el pointer.
--
-- SECURITY DEFINER: el trigger escribe el cache en usuarios; corre como owner →
-- pasa trg_proteger_usuarios (W3, que bloquea a authenticated/anon, no al owner).
-- No toca usuarios.status (cuenta) — D-W5-2 separa cuenta activa de socio activo.
-- Aditiva; BEGIN/COMMIT + backfill guardado (0 filas hoy) + self-tests.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION trg_sync_membresia_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_mem_id uuid;
  v_tier text;
BEGIN
  -- Durante cierre de tenant / reset del demo los usuarios se están borrando:
  -- saltar la sincronización (reusa las banderas de W4-A). Evita churn inútil.
  IF current_setting('sala.cierre_tenant', true) = 'on'
     OR current_setting('sala.ledger_purga_ok', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_user := COALESCE(NEW.usuario_id, OLD.usuario_id);
  IF v_user IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  -- Cache derivado = la membresía ACTIVA del socio (<=1 por índice único), si hay.
  SELECT m.id, t.slug
  INTO v_mem_id, v_tier
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = v_user AND m.status = 'activa'
  ORDER BY m.created_at DESC
  LIMIT 1;

  -- Solo escribe si cambió (evita churn y no dispara updates redundantes).
  UPDATE usuarios
  SET membresia_activa_id = v_mem_id,
      membresia_tier = v_tier
  WHERE id = v_user
    AND (membresia_activa_id IS DISTINCT FROM v_mem_id
         OR membresia_tier IS DISTINCT FROM v_tier);

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION trg_sync_membresia_cache() IS
  'W5-B. Mantiene usuarios.membresia_activa_id/membresia_tier como cache derivado '
  'de la membresía activa del socio, ante cualquier cambio en membresias. Salta '
  'bajo banderas de cierre/purga. Owner (DEFINER) → pasa el guard W3.';

DROP TRIGGER IF EXISTS sync_membresia_cache ON membresias;
CREATE TRIGGER sync_membresia_cache
  AFTER INSERT OR UPDATE OR DELETE ON membresias
  FOR EACH ROW
  EXECUTE FUNCTION trg_sync_membresia_cache();


-- ── Backfill guardado: reconcilia el cache con la derivación (0 filas hoy) ────
CREATE TEMP TABLE _w5b_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $$
DECLARE v_n integer;
BEGIN
  UPDATE usuarios u
  SET membresia_activa_id = c.mid,
      membresia_tier = c.slug
  FROM (
    SELECT u2.id AS uid, act.id AS mid, t.slug AS slug
    FROM usuarios u2
    LEFT JOIN LATERAL (
      SELECT m.id, m.tier_id FROM membresias m
      WHERE m.usuario_id = u2.id AND m.status = 'activa'
      ORDER BY m.created_at DESC LIMIT 1
    ) act ON true
    LEFT JOIN tiers t ON t.id = act.tier_id
    WHERE u2.rol = 'miembro'
  ) c
  WHERE u.id = c.uid
    AND (u.membresia_activa_id IS DISTINCT FROM c.mid
         OR u.membresia_tier IS DISTINCT FROM c.slug);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO _w5b_res VALUES (0, 'backfill de cache (filas corregidas; esperado 0 = ya limpio)', v_n::text);
END $$;


-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenant desechable; cerrar_tenant limpia.
-- Prueba las rutas: INSERT activa, cancelar (simula cancel/Stripe directo),
-- reactivar. La bandera de cierre hace que la limpieza NO dispare el sync.
-- ============================================================================
DO $$
DECLARE
  v_slug text := 'zz-w5b-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid; v_u uuid; v_tier uuid; v_mem uuid;
  v_ptr uuid; v_ctier text;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'W5B','gym_libre','activo') RETURNING id INTO v_tenant;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-u@sala.dev','U','miembro','activo') RETURNING id INTO v_u;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, duracion_dias) VALUES (v_tenant,'w5b-t','Tiempo',100000,'tiempo',30) RETURNING id INTO v_tier;

  -- T1: INSERT membresía activa → el trigger llena el cache.
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_u, v_tier, 'activa', now(), now()+interval '30 days') RETURNING id INTO v_mem;
  SELECT membresia_activa_id, membresia_tier INTO v_ptr, v_ctier FROM usuarios WHERE id=v_u;
  IF v_ptr IS DISTINCT FROM v_mem OR v_ctier IS DISTINCT FROM 'w5b-t' THEN
    RAISE EXCEPTION 'T1 FALLO: el cache no se llenó al crear la membresía (ptr=%, tier=%)', v_ptr, v_ctier; END IF;
  INSERT INTO _w5b_res VALUES (1, 'INSERT activa → cache llenado por trigger', 'OK');

  -- T2: escritura DIRECTA de status='cancelada' (simula Stripe subscription.deleted
  -- / cancel self-serve que hoy NO limpian el cache) → el trigger lo limpia.
  UPDATE membresias SET status='cancelada', cancelada_at=now() WHERE id=v_mem;
  SELECT membresia_activa_id, membresia_tier INTO v_ptr, v_ctier FROM usuarios WHERE id=v_u;
  IF v_ptr IS NOT NULL OR v_ctier IS NOT NULL THEN
    RAISE EXCEPTION 'T2 FALLO: el cache no se limpió al cancelar (ptr=%, tier=%)', v_ptr, v_ctier; END IF;
  INSERT INTO _w5b_res VALUES (2, 'UPDATE directo →cancelada limpia el cache (fix RC-05-D)', 'OK');

  -- T3: reactivar (cancelada→activa) → el trigger vuelve a llenar el cache.
  UPDATE membresias SET status='activa', cancelada_at=NULL WHERE id=v_mem;
  SELECT membresia_activa_id, membresia_tier INTO v_ptr, v_ctier FROM usuarios WHERE id=v_u;
  IF v_ptr IS DISTINCT FROM v_mem OR v_ctier IS DISTINCT FROM 'w5b-t' THEN
    RAISE EXCEPTION 'T3 FALLO: el cache no se re-llenó al reactivar (ptr=%, tier=%)', v_ptr, v_ctier; END IF;
  INSERT INTO _w5b_res VALUES (3, 'UPDATE →activa re-llena el cache', 'OK');

  PERFORM cerrar_tenant(v_slug);
END $$;

-- ── CONTRACT: W1/W2/W3/W4 + huella intactos ──────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  IF to_regclass('public.business_operations') IS NULL THEN RAISE EXCEPTION 'CONTRATO: business_operations (W1) ausente'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='reservar_clase_atomic' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('clase_lugares:' IN v_src)=0 THEN RAISE EXCEPTION 'CONTRATO: W2 lock ausente'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='trg_proteger_usuarios' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('membresia_tier' IN v_src)=0 THEN RAISE EXCEPTION 'CONTRATO: W3 ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='trg_membresia_credito_guard') THEN RAISE EXCEPTION 'CONTRATO: W4-A5 ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='check_in_por_huella') THEN RAISE EXCEPTION 'CONTRATO: huella ausente'; END IF;
  INSERT INTO _w5b_res VALUES (4, 'contract: W1/W2/W3/W4 + huella intactos', 'OK');
END $$;

SELECT orden, prueba, resultado FROM _w5b_res ORDER BY orden;

COMMIT;
