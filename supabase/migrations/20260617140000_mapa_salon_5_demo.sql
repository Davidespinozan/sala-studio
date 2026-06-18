-- ============================================================================
-- MAPA DE SALÓN · Lote 5 — sembrar un mapa en el demo (healthyspace)
-- ----------------------------------------------------------------------------
-- Le pone layout a la sala Cycling (Sucursal Principal): 12 bicis en 2 filas de
-- 6, con el coach al frente. Así el demo muestra el Mapa de Salón (vista socio y
-- ocupación admin) y sirve para el screenshot de la landing.
--
-- Además asigna lugar a las reservas activas que ya existen en clases de esa
-- sala (numeradas 1..N por clase), para que la vista de ocupación se vea llena.
-- ============================================================================

-- 1) Layout de la sala Cycling (bb18818b). cupo_max_default = 12 (= nº de lugares).
UPDATE recursos
SET
  cupo_max_default = 12,
  layout = jsonb_build_object(
    'tipo_icono', 'bici',
    'cols', 6,
    'rows', 3,
    'elementos', jsonb_build_array(
      jsonb_build_object('tipo', 'instructor', 'x', 2, 'y', 0, 'label', 'Coach')
    ),
    'lugares', jsonb_build_array(
      jsonb_build_object('id','L1','label','1','x',0,'y',1),
      jsonb_build_object('id','L2','label','2','x',1,'y',1),
      jsonb_build_object('id','L3','label','3','x',2,'y',1),
      jsonb_build_object('id','L4','label','4','x',3,'y',1),
      jsonb_build_object('id','L5','label','5','x',4,'y',1),
      jsonb_build_object('id','L6','label','6','x',5,'y',1),
      jsonb_build_object('id','L7','label','7','x',0,'y',2),
      jsonb_build_object('id','L8','label','8','x',1,'y',2),
      jsonb_build_object('id','L9','label','9','x',2,'y',2),
      jsonb_build_object('id','L10','label','10','x',3,'y',2),
      jsonb_build_object('id','L11','label','11','x',4,'y',2),
      jsonb_build_object('id','L12','label','12','x',5,'y',2)
    )
  )
WHERE id = 'bb18818b-c597-4951-b37a-0b0f63aa373b';

-- 2) Asignar lugar (L1..LN, ≤12) a las reservas activas de clases de esa sala.
WITH numeradas AS (
  SELECT
    r.id,
    'L' || row_number() OVER (PARTITION BY r.clase_id ORDER BY md5(r.id::text)) AS lugar
  FROM reservas r
  JOIN clases c ON c.id = r.clase_id
  WHERE c.recurso_id = 'bb18818b-c597-4951-b37a-0b0f63aa373b'
    AND r.status IN ('confirmada', 'completada')
)
UPDATE reservas
SET lugar_id = numeradas.lugar
FROM numeradas
WHERE reservas.id = numeradas.id
  AND numeradas.lugar IN ('L1','L2','L3','L4','L5','L6','L7','L8','L9','L10','L11','L12');
