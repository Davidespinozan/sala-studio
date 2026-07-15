-- ¿El índice de idempotencia de pagos ya incluye `concepto`?
-- Si la 3ra columna es 'concepto', plan e inscripción NO colisionan → el asiento
-- de inscripción se guarda. (Devuelve tabla; el editor esconde los NOTICE.)
SELECT
  'pagos_referencia_unica incluye concepto' AS prueba,
  '(tenant_id, referencia, concepto)'        AS espera,
  pg_get_indexdef(i.indexrelid)              AS definicion_real,
  CASE WHEN pg_get_indexdef(i.indexrelid) LIKE '%, concepto)%'
            OR pg_get_indexdef(i.indexrelid) LIKE '%, concepto WHERE%'
            OR pg_get_indexdef(i.indexrelid) LIKE '%concepto)%'
       THEN 'OK — no pierde la inscripción'
       ELSE 'FALLA — revisar' END           AS resultado
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = 'pagos_referencia_unica';
