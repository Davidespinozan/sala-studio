-- ============================================================================
-- usuarios.inscripcion_pagada_at: devolverle el SELECT a authenticated
-- ----------------------------------------------------------------------------
-- EL ACCIDENTE: 20260709160000 revocó el SELECT de TABLA sobre `usuarios` y
-- re-otorgó una LISTA BLANCA de columnas, para esconder `stripe_customer_id` y
-- `ob_data` (lo único sensible). Correcto. Pero esa lista es fija: toda columna
-- agregada DESPUÉS queda fuera del GRANT sin que nadie lo note.
--
-- `inscripcion_pagada_at` nació después (20260713100000) → quedó ilegible para
-- authenticated. No es sensible: solo dice si el socio ya pagó la cuota de alta.
--
-- QUÉ ROMPÍA: en Postgres, pedir una columna sin permiso NO la omite — rechaza
-- la consulta ENTERA. Y el código descartaba el error, así que fallaba mudo:
--   · AsignarPlanModal (recepción) leía inscripcion_pagada_at para saber si ya
--     la pagó → la query moría → yaPagoInscripcion quedaba SIEMPRE false → la
--     pantalla sumaba la inscripción al total aunque el socio ya la hubiera
--     pagado. Recepción le cobraba de más EN EFECTIVO, mientras el servidor
--     (que sí lee bien la columna) registraba en `pagos` solo el plan → el socio
--     pagaba de más y la caja no cuadraba.
--   · El aviso "ya pagó la inscripción" nunca se mostraba.
--
-- (El mismo accidente, con stripe_customer_id, dejaba a TODO socio sin poder
--  pagar: ver el fix de suscribir-membresia / metodo-pago.)
--
-- Nada que esconder acá: se otorga a authenticated. RLS sigue filtrando las
-- FILAS (cada quien ve lo suyo; recepción/admin, los de su tenant).
-- ============================================================================

GRANT SELECT (inscripcion_pagada_at) ON usuarios TO authenticated;


-- ============================================================================
-- VERIFICACIÓN — se espera todo OK.
-- ============================================================================
SELECT 'authenticated ya puede leer inscripcion_pagada_at' AS prueba,
       'legible' AS espera,
       CASE WHEN has_column_privilege('authenticated', 'usuarios', 'inscripcion_pagada_at', 'SELECT')
            THEN 'OK' ELSE 'FALLA' END AS resultado
UNION ALL
-- Lo sensible SIGUE cerrado: este fix no abre de más.
SELECT 'stripe_customer_id sigue oculto', 'ilegible',
       CASE WHEN has_column_privilege('authenticated', 'usuarios', 'stripe_customer_id', 'SELECT')
            THEN 'FALLA' ELSE 'OK' END
UNION ALL
SELECT 'ob_data sigue oculto', 'ilegible',
       CASE WHEN has_column_privilege('authenticated', 'usuarios', 'ob_data', 'SELECT')
            THEN 'FALLA' ELSE 'OK' END;


-- ============================================================================
-- RADAR: ¿qué columnas de `usuarios` NO puede leer authenticated hoy?
-- ----------------------------------------------------------------------------
-- La lista blanca es una trampa silenciosa: cada columna nueva nace ilegible y
-- rompe consultas en mudo. Esto la hace VISIBLE. Se esperan exactamente dos:
-- stripe_customer_id y ob_data. Si aparece una tercera, alguien agregó una
-- columna y hay que decidir a propósito si el cliente la necesita.
-- ============================================================================
SELECT
  'RADAR: columnas de usuarios ocultas a authenticated' AS nota,
  c.column_name AS columna,
  CASE WHEN c.column_name IN ('stripe_customer_id', 'ob_data')
       THEN 'esperada (sensible a propósito)'
       ELSE '⚠ REVISAR: ¿el cliente la necesita? Si sí, GRANT SELECT (col) …'
  END AS veredicto
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name = 'usuarios'
  AND NOT has_column_privilege('authenticated', 'usuarios', c.column_name, 'SELECT')
ORDER BY c.column_name;