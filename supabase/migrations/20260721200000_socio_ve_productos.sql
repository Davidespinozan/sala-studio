-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- El socio puede VER los productos (para comprar desde su app)
-- ============================================================================
-- La RLS de `productos` solo dejaba leer a staff (admin/recepción). Para que el
-- socio compre desde su app necesita ver el catálogo. Se agrega una policy que
-- deja a cualquier usuario del gym leer los productos ACTIVOS (el catálogo no es
-- secreto; el inactivo sigue siendo solo para staff, que lo gestiona).
--
-- No gatea por el toggle `venta_socio`: leer el catálogo es inofensivo, y la app
-- del socio solo muestra la tienda cuando el toggle está prendido. La RLS de
-- QUÉ puede hacer (comprar) la sigue controlando la RPC de venta.
-- ============================================================================

DROP POLICY IF EXISTS productos_ve_socio ON productos;
CREATE POLICY productos_ve_socio ON productos
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND activo);

-- Verificación: la policy quedó.
SELECT
  'productos_ve_socio' AS policy,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'productos' AND policyname = 'productos_ve_socio'
  ) THEN 'OK' ELSE '*** FALLA ***' END AS resultado;