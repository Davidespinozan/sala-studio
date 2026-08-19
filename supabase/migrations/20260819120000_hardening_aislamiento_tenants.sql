-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- HARDENING de aislamiento entre tenants (cierra los resquicios de la auditoría)
-- ----------------------------------------------------------------------------
-- La auditoría no encontró NINGUNA fuga de datos privados, listas ni dinero
-- entre tenants (RLS por tabla, RPCs, storage y webhooks están sólidos). Lo que
-- quedó son "oráculos escalares": funciones que, si alguien conoce de memoria el
-- UUID exacto de un objeto de OTRO tenant, devuelven UN solo número/enum sobre él
-- (un monto reembolsable, un estado de membresía, un conteo). No vuelcan datos,
-- pero violan la letra de "un tenant no ve nada de otro" y contradicen la
-- convención del propio proyecto (helpers sensibles = solo service_role).
--
-- Esta migración los cierra todos, sin cambiar el comportamiento del uso legítimo:
--   1) REVOKE de authenticated en 3 helpers que NADIE llama desde el front
--      (pago_reembolsable, _estado_membresia_checkin, _guard_membresia_checkin).
--   2) count_admins_activos / count_active_admins → cuentan el tenant PROPIO
--      (COALESCE(get_my_tenant_id(), p_tenant_id): ignora el parámetro para
--      authenticated, lo respeta para service_role → el Netlify sigue igual).
--   3) invitados_disponibles → un recepcionista solo consulta socios de SU tenant.
--   4) recepcion_cancelar_reserva / cambiar_plan / renovar_membresia → guard de
--      tenant al entrar: un objeto de otro tenant se ve idéntico a "no existe"
--      (mata el oráculo por-mensaje-de-error). El delegado ya bloqueaba el cambio
--      real; esto además tapa la lectura de estado.
--   5) vender_productos / ajustar_stock → validan que la sucursal (y el socio) del
--      parámetro sean del tenant del que cobra (integridad; la FK solo validaba
--      existencia, no tenant).
--
-- Cada función se reproduce VERBATIM de su última definición y se le agrega solo
-- el guard. Al final, un self-test que DEVUELVE TABLA verifica que los REVOKE
-- quedaron y que cada guard sigue presente (contrato).
-- ============================================================================


-- ── 1) Helpers de solo-lectura que no deben ser llamables por authenticated ──
-- Son SECURITY DEFINER usados INTERNAMENTE por otras RPC (que corren como owner,
-- así que siguen funcionando). Cero call sites en src/ y netlify/.
REVOKE EXECUTE ON FUNCTION pago_reembolsable(uuid)            FROM authenticated;
REVOKE EXECUTE ON FUNCTION _estado_membresia_checkin(uuid)   FROM authenticated;
REVOKE EXECUTE ON FUNCTION _guard_membresia_checkin(uuid)    FROM authenticated;


-- ── 2) Conteo de admins: siempre del tenant PROPIO ──────────────────────────
-- Antes recibían un p_tenant_id arbitrario y contaban ese tenant → un authenticated
-- podía contar los admins de cualquier gym. Ahora: si hay contexto de usuario
-- (authenticated), se usa SU tenant y se ignora el parámetro; si no lo hay
-- (service_role, p.ej. el Netlify admin-update-role), se respeta el parámetro.
CREATE OR REPLACE FUNCTION count_admins_activos(p_tenant_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM usuarios
  WHERE tenant_id = COALESCE(get_my_tenant_id(), p_tenant_id)
    AND rol = 'admin'
    AND status = 'activo';
$$;

CREATE OR REPLACE FUNCTION count_active_admins(p_tenant_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::integer FROM usuarios
  WHERE tenant_id = COALESCE(get_my_tenant_id(), p_tenant_id)
    AND rol = 'admin'
    AND status = 'activo';
$$;


-- ── 3) invitados_disponibles: recepción solo ve socios de su tenant ─────────
-- (Reproducida de 20260713110000 + guard de tenant tras el guard de rol.)
CREATE OR REPLACE FUNCTION invitados_disponibles(p_usuario_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_incluidos integer := 0;
  v_usados integer := 0;
  v_inicio timestamptz;
  v_fin timestamptz;
BEGIN
  IF p_usuario_id <> get_my_user_id() AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  -- Guard de tenant: aunque sea recepcionista, solo su propio gym. Un socio de
  -- otro tenant se rechaza igual que un id inexistente (sin oráculo).
  IF (SELECT tenant_id FROM usuarios WHERE id = p_usuario_id) IS DISTINCT FROM get_my_tenant_id() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  SELECT COALESCE(t.invitados_por_periodo, 0), m.periodo_actual_inicio, m.periodo_actual_fin
  INTO v_incluidos, v_inicio, v_fin
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('activa', 'trialing', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF NOT FOUND OR COALESCE(v_incluidos, 0) = 0 THEN
    RETURN jsonb_build_object('incluidos', 0, 'usados', 0, 'disponibles', 0);
  END IF;

  -- Créditos puros (sin vencimiento) → ventana = mes calendario.
  v_inicio := COALESCE(v_inicio, date_trunc('month', now()));
  v_fin    := COALESCE(v_fin, v_inicio + interval '1 month');

  -- El pase se gasta AL RESERVAR. 'no_show' lo quema (igual que el crédito);
  -- solo 'cancelada' lo devuelve, porque deja de contar en esta suma.
  SELECT COALESCE(SUM(r.invitados_count), 0)
  INTO v_usados
  FROM reservas r
  WHERE r.usuario_id = p_usuario_id
    AND r.status IN ('confirmada', 'completada', 'no_show')
    AND r.created_at >= v_inicio
    AND r.created_at <  v_fin;

  RETURN jsonb_build_object(
    'incluidos', v_incluidos,
    'usados', v_usados,
    'disponibles', GREATEST(v_incluidos - v_usados, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION invitados_disponibles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitados_disponibles(uuid) TO authenticated;


-- ── 4) Wrappers de recepción: guard de tenant al entrar ─────────────────────
-- El delegado (gestionar_membresia_socio / cancelar_reserva_atomic) ya bloquea el
-- CAMBIO real cross-tenant. Pero el wrapper leía el objeto por id SIN filtro de
-- tenant y devolvía errores distintos según su estado (YA_CANCELADA / TIER_IGUAL /
-- NO_EXISTE) → un oráculo por-error del estado de un objeto ajeno. El guard lo
-- iguala a "no existe".

-- 4a) recepcion_cancelar_reserva (de 20260612020000)
CREATE OR REPLACE FUNCTION recepcion_cancelar_reserva(
  p_reserva_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reserva RECORD;
  v_socio_nombre text;
  v_resultado jsonb;
BEGIN
  -- Guard de tenant: una reserva de otro tenant = "no existe" (sin oráculo).
  IF (SELECT tenant_id FROM reservas WHERE id = p_reserva_id) IS DISTINCT FROM get_my_tenant_id() THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;

  -- Motivo opcional en cancelar reserva (UX EKKO: aceptable).
  -- Si está vacío, lo seteamos a un texto genérico para que cancelar_reserva_atomic
  -- tenga algo que guardar en cancelada_motivo.
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    p_motivo := 'Cancelado por recepción';
  END IF;

  -- Capturar info de la reserva ANTES de cancelarla (para bitácora)
  SELECT r.id, r.status, r.usuario_id, u.nombre, r.slot_inicio, r.recurso_id
  INTO v_reserva
  FROM reservas r
  LEFT JOIN usuarios u ON u.id = r.usuario_id
  WHERE r.id = p_reserva_id;

  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_YA_CANCELADA: la reserva ya estaba cancelada';
  END IF;

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: la reserva ya tiene check-in completado';
  END IF;

  v_socio_nombre := v_reserva.nombre;

  -- Delegar al RPC existente
  SELECT cancelar_reserva_atomic(p_reserva_id, p_motivo) INTO v_resultado;

  PERFORM _audrec_log(
    'reserva.cancelar',
    'reserva',
    p_reserva_id,
    v_reserva.usuario_id,
    v_socio_nombre,
    format('Canceló reserva del %s. Motivo: %s',
           to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
           p_motivo),
    jsonb_build_object(
      'slot_inicio', v_reserva.slot_inicio,
      'recurso_id', v_reserva.recurso_id,
      'motivo', p_motivo,
      'status_anterior', v_reserva.status,
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_cancelar_reserva(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_cancelar_reserva(uuid, text) TO authenticated;

-- 4b) recepcion_cambiar_plan (de 20260716110000)
CREATE OR REPLACE FUNCTION recepcion_cambiar_plan(
  p_usuario_id uuid,
  p_nuevo_tier_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL,
  -- Ver gestionar_membresia_socio: sin esto, un cambio que quema clases se niega.
  p_confirmar_perdida boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membresia_actual RECORD;
  v_tier_anterior_id uuid;
  v_socio_nombre text;
  v_resultado jsonb;
BEGIN
  -- Guard de tenant: un socio de otro tenant = "sin membresía" (sin oráculo).
  IF (SELECT tenant_id FROM usuarios WHERE id = p_usuario_id) IS DISTINCT FROM get_my_tenant_id() THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía previa para cambiar';
  END IF;

  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cambiar de plan';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tiers WHERE id = p_nuevo_tier_id) THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: el nuevo plan no existe';
  END IF;

  SELECT m.id, m.tier_id, u.nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_membresia_actual.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía previa para cambiar';
  END IF;

  v_tier_anterior_id := v_membresia_actual.tier_id;
  v_socio_nombre := v_membresia_actual.nombre;

  IF v_tier_anterior_id = p_nuevo_tier_id THEN
    RAISE EXCEPTION 'TIER_IGUAL: el nuevo plan es igual al actual. Usá renovar en su lugar';
  END IF;

  SELECT gestionar_membresia_socio(
    p_usuario_id, p_nuevo_tier_id, p_motivo, p_metodo_pago, p_monto_centavos,
    p_confirmar_perdida
  )
  INTO v_resultado;

  PERFORM _audrec_log(
    'membresia.cambiar_plan',
    'membresia',
    v_membresia_actual.id,
    p_usuario_id,
    v_socio_nombre,
    format('Cambió de plan. Motivo: %s', p_motivo),
    jsonb_build_object(
      'tier_anterior_id', v_tier_anterior_id,
      'tier_nuevo_id', p_nuevo_tier_id,
      'motivo', p_motivo,
      'metodo_pago', p_metodo_pago,
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer, boolean) TO authenticated;

-- 4c) recepcion_renovar_membresia (de 20260713120000)
CREATE OR REPLACE FUNCTION recepcion_renovar_membresia(
  p_usuario_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membresia_actual RECORD;
  v_socio_nombre text;
  v_resultado jsonb;
BEGIN
  -- Guard de tenant: un socio de otro tenant = "sin membresía renovable".
  IF (SELECT tenant_id FROM usuarios WHERE id = p_usuario_id) IS DISTINCT FROM get_my_tenant_id() THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene una membresía renovable';
  END IF;

  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para renovar';
  END IF;

  -- Incluye 'congelada': renovar una pausada la reactiva y renueva.
  SELECT m.id, m.tier_id, m.status, u.nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('activa', 'expirada', 'past_due', 'congelada')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_membresia_actual.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene una membresía renovable';
  END IF;

  v_socio_nombre := v_membresia_actual.nombre;

  SELECT gestionar_membresia_socio(
    p_usuario_id, v_membresia_actual.tier_id, p_motivo, p_metodo_pago, p_monto_centavos
  )
  INTO v_resultado;

  PERFORM _audrec_log(
    'membresia.renovar',
    'membresia',
    v_membresia_actual.id,
    p_usuario_id,
    v_socio_nombre,
    format('Renovó membresía. Motivo: %s', p_motivo),
    jsonb_build_object(
      'tier_id', v_membresia_actual.tier_id,
      'motivo', p_motivo,
      'metodo_pago', p_metodo_pago,
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_renovar_membresia(uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_renovar_membresia(uuid, text, text, integer) TO authenticated;


-- ── 5) POS: la sucursal (y el socio) del parámetro deben ser del tenant ─────
-- La FK solo valida existencia, no tenant → sin esto se podía atar una venta o un
-- movimiento de stock a una sucursal_id de otro gym. Integridad, no fuga.

-- 5a) vender_productos (de 20260721170000)
CREATE OR REPLACE FUNCTION vender_productos(
  p_sucursal_id uuid,
  p_metodo text,
  p_items jsonb,               -- [{ producto_id, cantidad }]
  p_usuario_id uuid DEFAULT NULL  -- socio, si aplica; NULL = venta a la calle
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller usuarios;
  v_item jsonb;
  v_prod productos;
  v_cant integer;
  v_total integer := 0;
  v_moneda text := 'MXN';
  v_pago_id uuid;
BEGIN
  -- Quién cobra: staff del gym (recepción o admin).
  SELECT * INTO v_caller FROM usuarios WHERE auth_id = auth.uid();
  IF v_caller.id IS NULL OR v_caller.rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden vender';
  END IF;
  IF v_caller.status <> 'activo' THEN
    RAISE EXCEPTION 'CUENTA_INACTIVA';
  END IF;

  -- La sucursal y el socio del parámetro deben ser de ESTE gym (la FK no lo valida).
  IF p_sucursal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_caller.tenant_id
  ) THEN
    RAISE EXCEPTION 'SUCURSAL_INVALIDA: esa sucursal no es de este gimnasio';
  END IF;
  IF p_usuario_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM usuarios WHERE id = p_usuario_id AND tenant_id = v_caller.tenant_id
  ) THEN
    RAISE EXCEPTION 'SOCIO_INVALIDO: ese socio no es de este gimnasio';
  END IF;

  IF p_metodo NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO';
  END IF;
  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'SIN_ITEMS';
  END IF;

  -- Primer paso: validar cada producto y calcular el total. Todo o nada.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_prod FROM productos WHERE id = (v_item->>'producto_id')::uuid;
    IF v_prod.id IS NULL OR v_prod.tenant_id <> v_caller.tenant_id THEN
      RAISE EXCEPTION 'PRODUCTO_INVALIDO';
    END IF;
    IF v_prod.activo IS NOT TRUE THEN
      RAISE EXCEPTION 'PRODUCTO_INACTIVO: %', v_prod.nombre;
    END IF;
    v_cant := COALESCE((v_item->>'cantidad')::integer, 0);
    IF v_cant <= 0 THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA';
    END IF;
    v_total := v_total + v_prod.precio_centavos * v_cant;
    v_moneda := v_prod.moneda;
  END LOOP;

  -- El cobro entra a la Caja.
  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, moneda, metodo, cobrado_por
  ) VALUES (
    v_caller.tenant_id, p_sucursal_id, p_usuario_id, 'producto', v_total, v_moneda, p_metodo, v_caller.id
  )
  RETURNING id INTO v_pago_id;

  -- El stock se descuenta, atado a esa venta. Se PERMITE quedar en negativo (no
  -- se frena una venta real porque el conteo esté mal); el negativo se ve como
  -- alerta en la vista de stock.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO producto_movimientos (
      tenant_id, producto_id, sucursal_id, tipo, cantidad, pago_id, created_by
    ) VALUES (
      v_caller.tenant_id, (v_item->>'producto_id')::uuid, p_sucursal_id,
      'venta', -((v_item->>'cantidad')::integer), v_pago_id, v_caller.id
    );
  END LOOP;

  RETURN jsonb_build_object('pago_id', v_pago_id, 'total_centavos', v_total, 'moneda', v_moneda);
END; $$;

-- 5b) ajustar_stock (de 20260721170000)
CREATE OR REPLACE FUNCTION ajustar_stock(
  p_producto_id uuid,
  p_sucursal_id uuid,
  p_cantidad integer,   -- con signo
  p_tipo text,          -- 'entrada' | 'ajuste' | 'merma' | 'devolucion'
  p_motivo text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller usuarios;
  v_prod productos;
  v_id uuid;
BEGIN
  SELECT * INTO v_caller FROM usuarios WHERE auth_id = auth.uid();
  IF v_caller.id IS NULL OR v_caller.rol <> 'admin' THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo el admin ajusta stock';
  END IF;
  IF p_tipo NOT IN ('entrada', 'ajuste', 'merma', 'devolucion') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;
  IF p_cantidad = 0 THEN
    RAISE EXCEPTION 'CANTIDAD_CERO';
  END IF;

  SELECT * INTO v_prod FROM productos WHERE id = p_producto_id;
  IF v_prod.id IS NULL OR v_prod.tenant_id <> v_caller.tenant_id THEN
    RAISE EXCEPTION 'PRODUCTO_INVALIDO';
  END IF;

  -- La sucursal del parámetro debe ser de ESTE gym (la FK no lo valida).
  IF p_sucursal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_caller.tenant_id
  ) THEN
    RAISE EXCEPTION 'SUCURSAL_INVALIDA: esa sucursal no es de este gimnasio';
  END IF;

  INSERT INTO producto_movimientos (
    tenant_id, producto_id, sucursal_id, tipo, cantidad, motivo, created_by
  ) VALUES (
    v_caller.tenant_id, p_producto_id, p_sucursal_id, p_tipo, p_cantidad, p_motivo, v_caller.id
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

REVOKE ALL ON FUNCTION vender_productos(uuid, text, jsonb, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION ajustar_stock(uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vender_productos(uuid, text, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION ajustar_stock(uuid, uuid, integer, text, text) TO authenticated;


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA (el editor esconde los NOTICE).
-- Verifica: (a) los 3 REVOKE quedaron; (b) cada función recreada conserva el
-- guard de tenant / la validación nueva. Es un test de CONTRATO (mismo patrón que
-- _fn_llama en 20260717100000): si una recreación futura pierde el guard, falla.
-- ============================================================================
CREATE OR REPLACE FUNCTION _fn_contiene(p_fn text, p_needle text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = p_fn
      AND p.prosrc LIKE '%' || p_needle || '%'
  );
$$;

CREATE OR REPLACE FUNCTION _diag_hardening_tenants()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  b boolean;
BEGIN
  -- (a) REVOKE de authenticated en los 3 helpers de solo-lectura.
  prueba := 'pago_reembolsable NO ejecutable por authenticated';
  resultado := CASE WHEN has_function_privilege('authenticated', 'pago_reembolsable(uuid)', 'EXECUTE')
                    THEN '❌ sigue expuesta' ELSE '✅ revocada' END; RETURN NEXT;

  prueba := '_estado_membresia_checkin NO ejecutable por authenticated';
  resultado := CASE WHEN has_function_privilege('authenticated', '_estado_membresia_checkin(uuid)', 'EXECUTE')
                    THEN '❌ sigue expuesta' ELSE '✅ revocada' END; RETURN NEXT;

  prueba := '_guard_membresia_checkin NO ejecutable por authenticated';
  resultado := CASE WHEN has_function_privilege('authenticated', '_guard_membresia_checkin(uuid)', 'EXECUTE')
                    THEN '❌ sigue expuesta' ELSE '✅ revocada' END; RETURN NEXT;

  -- (b) Guards de tenant presentes en cada función recreada.
  prueba := 'count_admins_activos usa el tenant propio';
  resultado := CASE WHEN _fn_contiene('count_admins_activos', 'get_my_tenant_id') THEN '✅' ELSE '❌ falta guard' END; RETURN NEXT;

  prueba := 'count_active_admins usa el tenant propio';
  resultado := CASE WHEN _fn_contiene('count_active_admins', 'get_my_tenant_id') THEN '✅' ELSE '❌ falta guard' END; RETURN NEXT;

  prueba := 'invitados_disponibles con guard de tenant';
  resultado := CASE WHEN _fn_contiene('invitados_disponibles', 'get_my_tenant_id') THEN '✅' ELSE '❌ falta guard' END; RETURN NEXT;

  prueba := 'recepcion_cancelar_reserva con guard de tenant';
  resultado := CASE WHEN _fn_contiene('recepcion_cancelar_reserva', 'get_my_tenant_id') THEN '✅' ELSE '❌ falta guard' END; RETURN NEXT;

  prueba := 'recepcion_cambiar_plan con guard de tenant';
  resultado := CASE WHEN _fn_contiene('recepcion_cambiar_plan', 'get_my_tenant_id') THEN '✅' ELSE '❌ falta guard' END; RETURN NEXT;

  prueba := 'recepcion_renovar_membresia con guard de tenant';
  resultado := CASE WHEN _fn_contiene('recepcion_renovar_membresia', 'get_my_tenant_id') THEN '✅' ELSE '❌ falta guard' END; RETURN NEXT;

  prueba := 'vender_productos valida la sucursal del tenant';
  resultado := CASE WHEN _fn_contiene('vender_productos', 'SUCURSAL_INVALIDA') THEN '✅' ELSE '❌ falta guard' END; RETURN NEXT;

  prueba := 'ajustar_stock valida la sucursal del tenant';
  resultado := CASE WHEN _fn_contiene('ajustar_stock', 'SUCURSAL_INVALIDA') THEN '✅' ELSE '❌ falta guard' END; RETURN NEXT;

  RETURN;
END $$;

SELECT * FROM _diag_hardening_tenants();
DROP FUNCTION _diag_hardening_tenants();
DROP FUNCTION _fn_contiene(text, text);
