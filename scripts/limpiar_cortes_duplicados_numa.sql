-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref `omrlbvhbggnrwwzlgxji`
-- Limpieza ÚNICA: cortes de caja repetidos de numa (mismo periodo y sede).
-- Se conserva el MÁS ANTIGUO de cada grupo (el que recepción hizo primero) y se
-- borran las repeticiones. Un corte es un reporte: borrar duplicados no toca
-- pagos ni dinero. Correr primero el PASO 1 y revisar; luego el PASO 2.

-- PASO 1 · Vista previa: qué se borraría (debe listar los grupos con repetidos).
WITH num AS (
  SELECT c.id, c.sucursal_id, c.desde, c.hasta, c.created_at,
         row_number() OVER (PARTITION BY c.tenant_id, c.sucursal_id, c.desde, c.hasta ORDER BY c.created_at) AS n
  FROM cortes_caja c
  JOIN tenants t ON t.id = c.tenant_id
  WHERE t.slug = 'numawellness'
)
SELECT (desde AT TIME ZONE 'America/Mazatlan') AS desde_local,
       (hasta AT TIME ZONE 'America/Mazatlan') AS hasta_local,
       count(*) AS repetidos_a_borrar,
       min(created_at AT TIME ZONE 'America/Mazatlan') AS primera_repeticion
FROM num WHERE n > 1
GROUP BY desde, hasta ORDER BY desde;

-- PASO 2 · Borrar (devuelve TABLA con lo borrado). Descomentar para ejecutar.
-- WITH num AS (
--   SELECT c.id,
--          row_number() OVER (PARTITION BY c.tenant_id, c.sucursal_id, c.desde, c.hasta ORDER BY c.created_at) AS n
--   FROM cortes_caja c
--   JOIN tenants t ON t.id = c.tenant_id
--   WHERE t.slug = 'numawellness'
-- ),
-- borrados AS (
--   DELETE FROM cortes_caja WHERE id IN (SELECT id FROM num WHERE n > 1)
--   RETURNING desde, hasta
-- )
-- SELECT count(*) AS cortes_borrados,
--        (SELECT count(*) FROM cortes_caja c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'numawellness') AS cortes_que_quedan
-- FROM borrados;
