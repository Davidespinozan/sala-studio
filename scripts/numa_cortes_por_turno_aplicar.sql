-- CORRER EN: proyecto SALA-STUDIO (omrlbvhbggnrwwzlgxji)
-- Reconstruye los cortes por turno de numa. NO toca pagos ni dinero.
\pset pager off

CREATE TEMP TABLE _log (paso text, cuantos int) ON COMMIT DROP;

CREATE TEMP TABLE _dias ON COMMIT DROP AS
WITH p AS (
  SELECT t.id AS tenant, 'America/Mazatlan'::text AS tz, (now() AT TIME ZONE 'America/Mazatlan')::date AS hoy
  FROM tenants t WHERE t.slug = 'numawellness'
),
dias AS (
  SELECT p.tenant, p.hoy, d::date AS dia,
         (d::date::timestamp)                       AT TIME ZONE p.tz AS ini,
         (d::date::timestamp + interval '12 hours') AT TIME ZONE p.tz AS split,
         ((d::date + 1)::timestamp)                 AT TIME ZONE p.tz AS fin
  FROM p, generate_series(date '2026-09-14', p.hoy, interval '1 day') d
)
SELECT * FROM dias a
WHERE EXISTS (SELECT 1 FROM reservas r WHERE r.tenant_id = a.tenant AND r.check_in_at >= a.ini AND r.check_in_at < a.fin)
   OR EXISTS (SELECT 1 FROM pagos g WHERE g.tenant_id = a.tenant AND g.metodo <> 'cortesia' AND g.created_at >= a.ini AND g.created_at < a.fin);

WITH b AS (
  DELETE FROM cortes_caja c
  USING _dias a
  WHERE c.tenant_id = a.tenant AND c.hasta > a.ini AND COALESCE(c.desde, '-infinity') < a.fin
    AND NOT (c.desde = a.ini AND c.hasta = a.split)
    AND NOT (c.desde = a.split AND c.hasta <= a.fin)
  RETURNING c.id
) INSERT INTO _log SELECT '1. borrados fuera de turno', count(*) FROM b;

WITH rk AS (
  SELECT c.id, row_number() OVER (PARTITION BY a.dia ORDER BY c.hasta DESC, c.created_at ASC) AS n
  FROM cortes_caja c JOIN _dias a ON c.tenant_id = a.tenant AND c.desde = a.split AND c.hasta > a.split AND c.hasta <= a.fin
), b AS (
  DELETE FROM cortes_caja WHERE id IN (SELECT id FROM rk WHERE n > 1) RETURNING id
) INSERT INTO _log SELECT '2. vespertinos repetidos borrados', count(*) FROM b;

WITH rk AS (
  SELECT c.id, row_number() OVER (PARTITION BY a.dia ORDER BY c.created_at ASC) AS n
  FROM cortes_caja c JOIN _dias a ON c.tenant_id = a.tenant AND c.desde = a.ini AND c.hasta = a.split
), b AS (
  DELETE FROM cortes_caja WHERE id IN (SELECT id FROM rk WHERE n > 1) RETURNING id
) INSERT INTO _log SELECT '3. matutinos repetidos borrados', count(*) FROM b;

WITH faltan AS (
  SELECT a.tenant, a.ini AS desde, a.split AS hasta FROM _dias a
  WHERE NOT EXISTS (SELECT 1 FROM cortes_caja c WHERE c.tenant_id = a.tenant AND c.desde = a.ini AND c.hasta = a.split)
  UNION ALL
  SELECT a.tenant, a.split, a.fin FROM _dias a
  WHERE a.dia < a.hoy
    AND NOT EXISTS (SELECT 1 FROM cortes_caja c WHERE c.tenant_id = a.tenant AND c.desde = a.split AND c.hasta > a.split AND c.hasta <= a.fin)
), ins AS (
  INSERT INTO cortes_caja (tenant_id, sucursal_id, realizado_por, desde, hasta,
                           efectivo_esperado_centavos, fondo_centavos, efectivo_contado_centavos, diferencia_centavos, notas, resumen)
  SELECT f.tenant,
         (SELECT s.id FROM sucursales s WHERE s.tenant_id = f.tenant ORDER BY s.orden LIMIT 1),
         (SELECT u.id FROM usuarios u WHERE u.tenant_id = f.tenant AND u.email = 'recepcion@numawellness.com'),
         f.desde, f.hasta,
         e.efectivo, 0, e.efectivo, 0,
         'Corte del turno reconstruido por SALA el ' || to_char(now() AT TIME ZONE 'America/Mazatlan', 'DD/MM/YYYY') || ' (faltaba o se habia hecho como dia completo).',
         _resumen_corte(f.tenant, NULL, f.desde, f.hasta)
  FROM faltan f
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(g.monto_centavos), 0)::int AS efectivo FROM pagos g
    WHERE g.tenant_id = f.tenant AND g.metodo = 'efectivo' AND g.created_at >= f.desde AND g.created_at < f.hasta
  ) e
  RETURNING id
) INSERT INTO _log SELECT '4. turnos creados', count(*) FROM ins;

WITH u AS (
  UPDATE cortes_caja c SET sucursal_id = (SELECT s.id FROM sucursales s WHERE s.tenant_id = c.tenant_id ORDER BY s.orden LIMIT 1)
  WHERE c.tenant_id = (SELECT id FROM tenants WHERE slug = 'numawellness') AND c.sucursal_id IS NULL
  RETURNING id
) INSERT INTO _log SELECT '5. cortes a los que se les puso la sede', count(*) FROM u;

SELECT * FROM _log ORDER BY paso;

SELECT a.dia, to_char(a.dia, 'Dy') AS dow,
       (SELECT count(*) FROM cortes_caja c WHERE c.tenant_id = a.tenant AND c.desde = a.ini AND c.hasta = a.split) AS matutino,
       (SELECT count(*) FROM cortes_caja c WHERE c.tenant_id = a.tenant AND c.desde = a.split AND c.hasta > a.split AND c.hasta <= a.fin) AS vespertino,
       (SELECT count(*) FROM cortes_caja c WHERE c.tenant_id = a.tenant AND c.hasta > a.ini AND COALESCE(c.desde, '-infinity') < a.fin
          AND NOT (c.desde = a.ini AND c.hasta = a.split) AND NOT (c.desde = a.split AND c.hasta <= a.fin)) AS otros_debe_ser_0
FROM _dias a ORDER BY a.dia;
