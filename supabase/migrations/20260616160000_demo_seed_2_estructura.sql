-- ============================================================================
-- DEMO HEALTHYSPACE · Lote 2 — limpieza estructural + precios + instructores
-- ----------------------------------------------------------------------------
-- Antes de sembrar la parrilla y los datos, dejamos la estructura presentable:
--   1. Borra las 2 salas de prueba "(copia) Barre" / "(copia) (copia) Barre".
--      → quedan las reales: Barre, Cycling, Pilates.
--   2. Pone precio a los 2 planes (estaban en $0 → reportes de Economía en cero):
--      Básica = $700 MXN/mes, Pro = $1,200 MXN/mes.
--   3. Renombra los 4 instructores a nombres neutros y realistas.
--   4. Normaliza el casing de la sucursal "sucursal culiacan".
--
-- Todo curado por migración (postgres) porque los guardrails dejan la estructura
-- del demo de solo lectura desde la app.
-- ============================================================================

-- 1) Borrar salas de prueba (cascada sus horarios/clases; no hay reservas).
DELETE FROM recursos
WHERE id IN (
  '3fa43dcf-fef1-4d6d-9606-801cd147a0fc',  -- (copia) (copia) Barre
  'f5a73bea-f4f9-4db7-87a9-33505be2af67'   -- (copia) Barre
);

-- 2) Precios de los planes (precio_centavos; MXN, mensual).
UPDATE tiers SET precio_centavos =  70000 WHERE id = '47945423-f3a3-45fe-974f-7c76cd29a1b1'; -- Básica $700
UPDATE tiers SET precio_centavos = 120000 WHERE id = '0b793fb4-ce5a-4220-bb68-35f33e8e1ef1'; -- Pro    $1,200

-- 3) Renombrar instructores.
UPDATE instructores SET nombre = 'Andrés Lara'   WHERE id = 'c825b4df-4f1f-4d7f-a1d8-6e08784e28f5'; -- era David Espinoza
UPDATE instructores SET nombre = 'Valeria Cruz'  WHERE id = '27491ab6-38fa-421b-ada4-6e73137431fc'; -- era Julieta Venegas
UPDATE instructores SET nombre = 'Mariana Soto'  WHERE id = 'ea88fbbd-cd62-45ec-a1ba-4d37d5c5b145'; -- era Maria Rios
UPDATE instructores SET nombre = 'Diego Fuentes' WHERE id = 'e9f537c7-bcba-4b48-bc87-b3414ed4f3a2'; -- era Pablo Escobar

-- 4) Casing de la sucursal.
UPDATE sucursales SET nombre = 'Sucursal Culiacán'
WHERE id = '5235387a-1196-48b2-8c2e-2a9c04a6d674';
