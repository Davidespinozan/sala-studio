-- ►► CORRER EN: proyecto SALA-STUDIO — ref `omrlbvhbggnrwwzlgxji`  (solo LEE)
-- Vista previa de la reconstrucción de cortes por turno de numa (autorizada por
-- David el 17-oct-2026). Alcance: desde el 14-sep-2026 (cuando empezaron con
-- cambio de turno a las 12:00) hasta hoy. Día "trabajado" = tuvo al menos un
-- check-in o un cobro (no cortesía). Para cada día trabajado el objetivo es:
--   · matutino   [00:00, 12:00)
--   · vespertino [12:00, cierre]  (si falta se crea hasta medianoche; hoy no se crea)
-- Todo lo demás que caiga en un día trabajado (día completo, 00:00→14:00,
-- 10:00→20:45, vespertinos repetidos) se borra. Los días no trabajados no se tocan.
\pset pager off

WITH p AS (
  SELECT t.id AS tenant, 'America/Mazatlan'::text AS tz, date '2026-09-14' AS d0,
         (now() AT TIME ZONE 'America/Mazatlan')::date AS hoy
  FROM tenants t WHERE t.slug = 'numawellness'
),
dias AS (
  SELECT p.tenant, p.hoy, d::date AS dia,
         (d::date::timestamp)                       AT TIME ZONE p.tz AS ini,
         (d::date::timestamp + interval '12 hours') AT TIME ZONE p.tz AS split,
         ((d::date + 1)::timestamp)                 AT TIME ZONE p.tz AS fin
  FROM p, generate_series(p.d0, p.hoy, interval '1 day') d
),
s AS (
  SELECT a.*,
    (SELECT count(*) FROM reservas r WHERE r.tenant_id = a.tenant AND r.check_in_at >= a.ini AND r.check_in_at < a.fin) AS checkins,
    (SELECT count(*) FROM pagos g WHERE g.tenant_id = a.tenant AND g.metodo <> 'cortesia' AND g.created_at >= a.ini AND g.created_at < a.fin) AS cobros,
    (SELECT count(*) FROM cortes_caja c WHERE c.tenant_id = a.tenant AND c.desde = a.ini AND c.hasta = a.split) AS matutinos,
    (SELECT count(*) FROM cortes_caja c WHERE c.tenant_id = a.tenant AND c.desde = a.split AND c.hasta > a.split AND c.hasta <= a.fin) AS vespertinos,
    (SELECT count(*) FROM cortes_caja c WHERE c.tenant_id = a.tenant AND c.hasta > a.ini AND COALESCE(c.desde, '-infinity') < a.fin
       AND NOT (c.desde = a.ini AND c.hasta = a.split)
       AND NOT (c.desde = a.split AND c.hasta <= a.fin)) AS otros
  FROM dias a
)
SELECT dia, to_char(dia, 'Dy') AS dow, checkins, cobros,
       matutinos AS mat, vespertinos AS vesp, otros,
       CASE
         WHEN checkins = 0 AND cobros = 0 THEN 'no trabajado · sin cambios'
         ELSE concat_ws(' · ',
           CASE WHEN matutinos = 0 THEN 'CREAR matutino' WHEN matutinos > 1 THEN 'dejar 1 matutino' END,
           CASE WHEN vespertinos = 0 AND dia < hoy THEN 'CREAR vespertino'
                WHEN vespertinos = 0 THEN 'vespertino: lo hacen hoy al cerrar'
                WHEN vespertinos > 1 THEN 'dejar 1 vespertino (el que cierra más tarde)' END,
           CASE WHEN otros > 0 THEN 'BORRAR ' || otros || ' corte(s) fuera de turno' END,
           CASE WHEN matutinos = 1 AND (vespertinos = 1 OR (vespertinos = 0 AND dia = hoy)) AND otros = 0 THEN 'ok, sin cambios' END)
       END AS accion
FROM s ORDER BY dia;

-- Detalle de lo que se BORRARÍA (cortes fuera de turno en días trabajados)
WITH p AS (
  SELECT t.id AS tenant, 'America/Mazatlan'::text AS tz FROM tenants t WHERE t.slug = 'numawellness'
),
dias AS (
  SELECT p.tenant, d::date AS dia,
         (d::date::timestamp) AT TIME ZONE p.tz AS ini,
         (d::date::timestamp + interval '12 hours') AT TIME ZONE p.tz AS split,
         ((d::date + 1)::timestamp) AT TIME ZONE p.tz AS fin
  FROM p, generate_series(date '2026-09-14', (now() AT TIME ZONE p.tz)::date, interval '1 day') d
),
trab AS (
  SELECT * FROM dias a
  WHERE EXISTS (SELECT 1 FROM reservas r WHERE r.tenant_id = a.tenant AND r.check_in_at >= a.ini AND r.check_in_at < a.fin)
     OR EXISTS (SELECT 1 FROM pagos g WHERE g.tenant_id = a.tenant AND g.metodo <> 'cortesia' AND g.created_at >= a.ini AND g.created_at < a.fin)
)
SELECT a.dia,
       c.desde AT TIME ZONE 'America/Mazatlan' AS desde_local,
       c.hasta AT TIME ZONE 'America/Mazatlan' AS hasta_local,
       c.created_at AT TIME ZONE 'America/Mazatlan' AS creado_local,
       (c.resumen->>'total_centavos')::int / 100.0 AS total
FROM trab a
JOIN cortes_caja c ON c.tenant_id = a.tenant AND c.hasta > a.ini AND COALESCE(c.desde, '-infinity') < a.fin
WHERE NOT (c.desde = a.ini AND c.hasta = a.split)
  AND NOT (c.desde = a.split AND c.hasta <= a.fin)
ORDER BY a.dia, c.created_at;
