-- =============================================================================
-- S4.1 — Verificación post-migración
-- =============================================================================
-- Corré este script DESPUÉS de aplicar 20260519100000_create_clases_table.sql.
-- No modifica datos: solo emite NOTICEs con métricas + RAISE si alguna
-- invariante crítica falla.
--
-- Invariantes verificadas:
--   1. La tabla `clases` existe y tiene >= 200 filas (~290 esperadas para
--      sala-demo con 60 días forward).
--   2. Toda clase tiene cupo_max >= 1.
--   3. Toda clase apunta a un recurso_id válido (FK ya lo garantiza, pero
--      verificamos por defensa).
--   4. Toda reserva activa (confirmada/completada/no_show) tiene clase_id.
--   5. No hay duplicados de (tenant, recurso, fecha, hora_inicio) entre clases
--      NO canceladas (el unique index parcial ya lo garantiza; lo re-validamos).
--
-- Reporte adicional:
--   - Clases por sala
--   - Clases por origen (recurrente vs manual)
--   - Reservas migradas con detalle de cuántas via F1 (recurrente) y F2/F3
--     (sintética).
-- =============================================================================

DO $$
DECLARE
  v_tenant_id uuid;
  v_total_clases integer;
  v_total_clases_recurrentes integer;
  v_total_clases_manuales integer;
  v_cupo_invalido integer;
  v_recurso_invalido integer;
  v_reservas_activas integer;
  v_reservas_sin_clase integer;
  v_reservas_via_recurrente integer;
  v_reservas_via_manual integer;
  v_duplicados integer;
  v_errores integer := 0;
  v_row record;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'sala-demo';
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant sala-demo no existe; no puedo verificar';
  END IF;

  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
  RAISE NOTICE 'S4.1 · Verificación post-migración para tenant sala-demo';
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';

  -- ─── Invariante 1: total de clases ───
  SELECT count(*) INTO v_total_clases
  FROM clases WHERE tenant_id = v_tenant_id;

  SELECT count(*) INTO v_total_clases_recurrentes
  FROM clases WHERE tenant_id = v_tenant_id AND origen = 'recurrente';

  SELECT count(*) INTO v_total_clases_manuales
  FROM clases WHERE tenant_id = v_tenant_id AND origen = 'manual';

  RAISE NOTICE '';
  RAISE NOTICE '[1] Total de clases generadas: %', v_total_clases;
  RAISE NOTICE '    - recurrente: %', v_total_clases_recurrentes;
  RAISE NOTICE '    - manual (sintética): %', v_total_clases_manuales;

  IF v_total_clases < 200 THEN
    RAISE WARNING 'Total clases (%) menor que el umbral esperado (200). Revisar horarios de recursos activos.', v_total_clases;
    v_errores := v_errores + 1;
  END IF;

  -- ─── Invariante 2: cupo_max >= 1 ───
  SELECT count(*) INTO v_cupo_invalido
  FROM clases WHERE tenant_id = v_tenant_id AND cupo_max < 1;
  RAISE NOTICE '';
  RAISE NOTICE '[2] Clases con cupo_max < 1: %', v_cupo_invalido;
  IF v_cupo_invalido > 0 THEN
    RAISE WARNING 'Hay % clases con cupo_max inválido', v_cupo_invalido;
    v_errores := v_errores + 1;
  END IF;

  -- ─── Invariante 3: recurso_id válido ───
  SELECT count(*) INTO v_recurso_invalido
  FROM clases c
  LEFT JOIN recursos r ON r.id = c.recurso_id
  WHERE c.tenant_id = v_tenant_id AND r.id IS NULL;
  RAISE NOTICE '';
  RAISE NOTICE '[3] Clases con recurso_id huérfano: %', v_recurso_invalido;
  IF v_recurso_invalido > 0 THEN
    RAISE WARNING 'Hay % clases sin recurso (rompería el FK)', v_recurso_invalido;
    v_errores := v_errores + 1;
  END IF;

  -- ─── Invariante 4: reservas activas todas linkeadas ───
  SELECT count(*) INTO v_reservas_activas
  FROM reservas
  WHERE tenant_id = v_tenant_id
    AND status IN ('confirmada','completada','no_show');

  SELECT count(*) INTO v_reservas_sin_clase
  FROM reservas
  WHERE tenant_id = v_tenant_id
    AND status IN ('confirmada','completada','no_show')
    AND clase_id IS NULL;

  SELECT count(*) INTO v_reservas_via_recurrente
  FROM reservas r
  JOIN clases c ON c.id = r.clase_id
  WHERE r.tenant_id = v_tenant_id
    AND r.status IN ('confirmada','completada','no_show')
    AND c.origen = 'recurrente';

  SELECT count(*) INTO v_reservas_via_manual
  FROM reservas r
  JOIN clases c ON c.id = r.clase_id
  WHERE r.tenant_id = v_tenant_id
    AND r.status IN ('confirmada','completada','no_show')
    AND c.origen = 'manual';

  RAISE NOTICE '';
  RAISE NOTICE '[4] Reservas activas (confirmada/completada/no_show): %', v_reservas_activas;
  RAISE NOTICE '    - linkeadas via clase recurrente: %', v_reservas_via_recurrente;
  RAISE NOTICE '    - linkeadas via clase manual (sintética): %', v_reservas_via_manual;
  RAISE NOTICE '    - sin clase_id (debe ser 0): %', v_reservas_sin_clase;
  IF v_reservas_sin_clase > 0 THEN
    RAISE WARNING 'Hay % reservas activas sin clase_id', v_reservas_sin_clase;
    v_errores := v_errores + 1;
  END IF;

  -- ─── Invariante 5: no duplicados de slot ───
  SELECT count(*) INTO v_duplicados
  FROM (
    SELECT tenant_id, recurso_id, fecha, hora_inicio
    FROM clases
    WHERE tenant_id = v_tenant_id AND status != 'cancelada'
    GROUP BY tenant_id, recurso_id, fecha, hora_inicio
    HAVING count(*) > 1
  ) dup;
  RAISE NOTICE '';
  RAISE NOTICE '[5] Slots con clases duplicadas no canceladas: %', v_duplicados;
  IF v_duplicados > 0 THEN
    RAISE WARNING 'Hay % slots con clases duplicadas (el unique index parcial debería haberlo impedido)', v_duplicados;
    v_errores := v_errores + 1;
  END IF;

  -- ─── Reporte: clases por sala ───
  RAISE NOTICE '';
  RAISE NOTICE '─── Distribución de clases por sala ───';
  FOR v_row IN
    SELECT rec.nombre, count(c.id) AS total
    FROM recursos rec
    LEFT JOIN clases c ON c.recurso_id = rec.id AND c.tenant_id = v_tenant_id
    WHERE rec.tenant_id = v_tenant_id AND rec.activo = true
    GROUP BY rec.nombre
    ORDER BY rec.nombre
  LOOP
    RAISE NOTICE '    %: %', rpad(v_row.nombre, 24, ' '), v_row.total;
  END LOOP;

  -- ─── Cierre ───
  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
  IF v_errores = 0 THEN
    RAISE NOTICE 'Verificación OK: ninguna invariante violada.';
  ELSE
    RAISE WARNING 'Verificación con % violación(es). Revisar mensajes arriba.', v_errores;
  END IF;
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
END $$;
