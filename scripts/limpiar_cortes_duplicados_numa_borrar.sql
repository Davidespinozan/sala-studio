-- ►► CORRER EN: proyecto SALA-STUDIO — ref `omrlbvhbggnrwwzlgxji`
-- Borra los cortes de caja repetidos de numa conservando el más antiguo de cada grupo.
-- PASO 2 · Borrar (devuelve TABLA con lo borrado). Descomentar para ejecutar.
WITH num AS (
  SELECT c.id,
         row_number() OVER (PARTITION BY c.tenant_id, c.sucursal_id, c.desde, c.hasta ORDER BY c.created_at) AS n
  FROM cortes_caja c
  JOIN tenants t ON t.id = c.tenant_id
  WHERE t.slug = 'numawellness'
),
borrados AS (
  DELETE FROM cortes_caja WHERE id IN (SELECT id FROM num WHERE n > 1)
  RETURNING desde, hasta
)
SELECT count(*) AS cortes_borrados,
       (SELECT count(*) FROM cortes_caja c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'numawellness') AS cortes_que_quedan
FROM borrados;
