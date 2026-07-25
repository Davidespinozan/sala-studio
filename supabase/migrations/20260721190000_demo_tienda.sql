-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- DEMO HEALTHYSPACE · la Tienda prendida y con productos
-- ============================================================================
-- Si en el demo la tienda no se ve, el prospecto asume que SALA no vende
-- productos y se va. Así que en el tenant demo se prende el módulo y se siembran
-- productos con stock, para que se vea vivo.
--
-- El reset nocturno del demo NO toca `productos` ni `producto_movimientos` (no
-- existían cuando se escribió), así que el seed sobrevive solo. Igual el stock
-- se backdatea para que muestre algo de historia.
--
-- Idempotente: limpia el seed previo (los productos de este lote, por nombre) y
-- reinserta.
-- ============================================================================

-- ── 1) Prender el módulo, sin pisar el resto del config ─────────────────────
-- Se asegura que `modulos` exista antes de setear `tienda` (jsonb_set no crea
-- objetos intermedios).
UPDATE tenants
SET config = jsonb_set(
      jsonb_set(coalesce(config, '{}'::jsonb), '{modulos}', coalesce(config->'modulos', '{}'::jsonb), true),
      '{modulos,tienda}', 'true'::jsonb, true)
WHERE slug = 'healthyspace';

-- ── 2) Productos del demo ───────────────────────────────────────────────────
DO $$
DECLARE
  v_tenant uuid;
  v_suc uuid;
  v_prod uuid;
  v_item record;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  IF v_tenant IS NULL THEN RAISE NOTICE 'no hay tenant demo, nada que sembrar'; RETURN; END IF;
  SELECT id INTO v_suc FROM sucursales WHERE tenant_id = v_tenant ORDER BY orden NULLS LAST, created_at LIMIT 1;

  -- Limpieza del seed previo (por los nombres de este lote).
  PERFORM set_config('sala.cierre_tenant', 'on', true); -- para poder borrar movimientos
  DELETE FROM producto_movimientos
  WHERE tenant_id = v_tenant
    AND producto_id IN (SELECT id FROM productos WHERE tenant_id = v_tenant
                        AND nombre IN ('Proteína Whey (dosis)', 'Agua 600ml', 'Barrita proteica', 'Playera SALA', 'Shaker'));
  DELETE FROM productos
  WHERE tenant_id = v_tenant
    AND nombre IN ('Proteína Whey (dosis)', 'Agua 600ml', 'Barrita proteica', 'Playera SALA', 'Shaker');
  PERFORM set_config('sala.cierre_tenant', 'off', true);

  -- Alta de productos + su stock inicial (entrada backdateada).
  FOR v_item IN
    SELECT * FROM (VALUES
      ('Proteína Whey (dosis)', 'Suplementos', 4500, 40),
      ('Agua 600ml',           'Bebidas',      2000, 120),
      ('Barrita proteica',     'Snacks',       3500, 60),
      ('Playera SALA',         'Ropa',        25000, 15),
      ('Shaker',               'Accesorios',  12000, 8)
    ) AS x(nombre, categoria, precio, stock)
  LOOP
    INSERT INTO productos (tenant_id, nombre, categoria, precio_centavos)
    VALUES (v_tenant, v_item.nombre, v_item.categoria, v_item.precio)
    RETURNING id INTO v_prod;

    INSERT INTO producto_movimientos (tenant_id, producto_id, sucursal_id, tipo, cantidad, motivo, created_at)
    VALUES (v_tenant, v_prod, v_suc, 'entrada', v_item.stock, 'Carga inicial (demo)', now() - interval '20 days');
  END LOOP;
END $$;

-- ── Verificación: módulo prendido + productos con stock ─────────────────────
SELECT * FROM (
  SELECT 1 AS orden, 'Módulo tienda prendido en el demo' AS que,
         CASE WHEN (SELECT config->'modulos'->>'tienda' FROM tenants WHERE slug = 'healthyspace') = 'true'
              THEN 'OK' ELSE '*** FALLA ***' END AS resultado
  UNION ALL
  SELECT 2, 'Productos sembrados',
         (SELECT count(*)::text FROM productos p JOIN tenants t ON t.id = p.tenant_id
          WHERE t.slug = 'healthyspace') || ' productos'
  UNION ALL
  SELECT 3, 'Stock cargado (unidades totales)',
         (SELECT coalesce(sum(stock), 0)::text FROM producto_stock ps JOIN tenants t ON t.id = ps.tenant_id
          WHERE t.slug = 'healthyspace') || ' unidades'
) x ORDER BY orden;