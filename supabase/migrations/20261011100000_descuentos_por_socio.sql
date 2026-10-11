-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref `omrlbvhbggnrwwzlgxji`
--
-- ── Descuentos por socio (The Core Studio: 20% a estudiantes) ────────────────
-- Problema: SALA no tenía descuentos. El gym los parchaba duplicando planes
-- ("40clases -% itzel 2"). El descuento es un atributo del SOCIO (es estudiante),
-- no del plan.
--
-- Modelo:
--   descuentos        → catálogo del gym (nombre, %, meses de vigencia). Lo edita
--                       el admin (Cobros). Nada hardcodeado.
--   socio_descuentos  → a quién se le otorgó, quién y hasta cuándo. UNO por socio.
--                       Tabla propia (NO columnas en usuarios: lista blanca).
--   Vencimiento       → por FECHA (vence_el, inclusive, en la zona del gym). Sin
--                       cron: vencido = deja de aplicar solo.
--
-- Reglas del precio (_precio_plan_para_socio, ÚNICA fuente):
--   • aplica al precio del PLAN; NUNCA a la inscripción, multas ni productos
--   • no aplica a pases de día (es_pase) ni a la clase de prueba (es_prueba)
--   • canal 'app' (Stripe): solo paquetes de pago único (creditos/hibrido). Las
--     mensualidades con cobro automático quedan a precio de lista: el precio de
--     la suscripción queda fijo y seguiría rebajado aunque el estatus venza.
--   • canal 'recepcion': cualquier plan
--
-- Cobro: gestionar_membresia_socio (motor de asignar/renovar/cambiar plan de
-- recepción y admin) usa ese precio cuando NO le mandan un monto explícito, y
-- deja la etiqueta en la nota del pago ("… · Estudiante -20%").
--
-- Aditivo. Sin descuentos otorgados, todo cobra igual que antes.
-- ============================================================================

-- ── 0) Guard: el motor en la base debe ser el que esta migración reescribe ──
DO $$
DECLARE
  v_n integer;
  v_def text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'gestionar_membresia_socio';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'GUARD: se esperaba 1 gestionar_membresia_socio, hay %. No se aplicó nada.', v_n;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'gestionar_membresia_socio';
  -- Re-correr esta migración es seguro: si ya está aplicada, pasa.
  IF v_def LIKE '%_precio_plan_para_socio%' THEN
    RETURN;
  END IF;
  IF v_def NOT LIKE '%_guard_sucursal_recepcion%'
     OR v_def NOT LIKE '%p_operation_key%'
     OR v_def NOT LIKE '%v_monto_plan := COALESCE(p_monto_centavos, v_tier.precio_centavos, 0)%' THEN
    RAISE EXCEPTION 'GUARD: gestionar_membresia_socio en la base no es la versión de 20261005260000. No se aplicó nada: avisar antes de seguir.';
  END IF;
END $$;

-- ── 1) Catálogo de descuentos del gym ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS descuentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre text NOT NULL CHECK (length(trim(nombre)) > 0),
  porcentaje integer NOT NULL CHECK (porcentaje BETWEEN 1 AND 100),
  -- Vigencia sugerida al otorgarlo (recepción puede ajustar la fecha).
  vigencia_meses integer NOT NULL DEFAULT 6 CHECK (vigencia_meses BETWEEN 1 AND 24),
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS descuentos_tenant_nombre_uniq
  ON descuentos (tenant_id, lower(trim(nombre)));

DROP TRIGGER IF EXISTS descuentos_set_updated_at ON descuentos;
CREATE TRIGGER descuentos_set_updated_at
  BEFORE UPDATE ON descuentos
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE descuentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS descuentos_read_tenant ON descuentos;
CREATE POLICY descuentos_read_tenant ON descuentos
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id());

DROP POLICY IF EXISTS descuentos_admin_all ON descuentos;
CREATE POLICY descuentos_admin_all ON descuentos
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- ── 2) Descuento otorgado a un socio ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS socio_descuentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
  descuento_id uuid NOT NULL REFERENCES descuentos(id) ON DELETE CASCADE,
  -- Último día (inclusive) en que aplica, en la fecha local del gym.
  vence_el date NOT NULL,
  otorgado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_socio_descuentos_tenant ON socio_descuentos (tenant_id);
CREATE INDEX IF NOT EXISTS idx_socio_descuentos_descuento ON socio_descuentos (descuento_id);

ALTER TABLE socio_descuentos ENABLE ROW LEVEL SECURITY;

-- Lectura: el staff del gym, y el socio el suyo. Escritura: SOLO por los RPCs
-- de abajo (sin policy de INSERT/UPDATE/DELETE → nadie se lo pone solo).
DROP POLICY IF EXISTS socio_descuentos_read ON socio_descuentos;
CREATE POLICY socio_descuentos_read ON socio_descuentos
  FOR SELECT
  TO authenticated
  USING (
    tenant_id = get_my_tenant_id()
    AND (is_recepcionista() OR usuario_id = get_my_user_id())
  );

REVOKE INSERT, UPDATE, DELETE ON socio_descuentos FROM PUBLIC, anon, authenticated;

-- ── 3) Bitácora: dos acciones nuevas (DROP + ADD con la lista completa) ─────
ALTER TABLE auditoria_recepcion DROP CONSTRAINT IF EXISTS auditoria_recepcion_accion_check;
ALTER TABLE auditoria_recepcion ADD CONSTRAINT auditoria_recepcion_accion_check
  CHECK (accion IN (
    'membresia.ajustar_creditos','membresia.alta','membresia.renovar','membresia.cambiar_plan',
    'membresia.recargar_creditos','membresia.congelar','membresia.reactivar','membresia.cancelar',
    'membresia.programar_cancelacion_stripe','membresia.retirar_cancelacion_stripe',
    'reserva.crear','reserva.cancelar','reserva.lista_espera_anotar','reserva.lista_espera_promover',
    'socio.crear','socio.editar_contacto','socio.reset_password','socio.bloquear','socio.desbloquear',
    'socio.nota','socio.aviso','socio.huella_enrolar','socio.huella_revocar',
    'socio.descuento_otorgar','socio.descuento_quitar',
    'clase.crear','clase.cancelar','clase.editar','clase.reasignar_coach','clase.marcar_asistencia','clase.marcar_no_show',
    'pago.reenviar_link','pago.activar','pago.reembolso',
    'checkin.manual','checkin.qr','checkin.corregir','checkin.huella'
  ));

-- ── 4) Precio de un plan para un socio — ÚNICA fuente de la regla ───────────
-- Interna (sin chequeo de permisos): la llaman el motor de cobro, los wrappers
-- de abajo y el checkout de Stripe (service_role).
CREATE OR REPLACE FUNCTION _precio_plan_para_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_canal text DEFAULT 'recepcion'
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier tiers;
  v_socio RECORD;
  v_d RECORD;
  v_hoy date;
  v_lista integer;
  v_desc integer := 0;
  v_aplica boolean := false;
BEGIN
  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  SELECT id, tenant_id, sucursal_id INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_tier.id IS NULL OR v_socio.id IS NULL OR v_tier.tenant_id <> v_socio.tenant_id THEN
    RETURN NULL;
  END IF;

  v_lista := GREATEST(COALESCE(v_tier.precio_centavos, 0), 0);
  v_hoy := (now() AT TIME ZONE timezone_de_sucursal(v_socio.sucursal_id, v_socio.tenant_id))::date;

  SELECT d.id, d.nombre, d.porcentaje, sd.vence_el
  INTO v_d
  FROM socio_descuentos sd
  JOIN descuentos d ON d.id = sd.descuento_id
  WHERE sd.usuario_id = p_usuario_id
    AND d.tenant_id = v_socio.tenant_id
    AND d.activo
    AND sd.vence_el >= v_hoy;

  v_aplica := v_d.id IS NOT NULL
    AND v_lista > 0
    AND NOT COALESCE(v_tier.es_pase, false)
    AND NOT COALESCE(v_tier.es_prueba, false)
    AND (COALESCE(p_canal, 'recepcion') <> 'app' OR v_tier.tipo IN ('creditos', 'hibrido'));

  IF v_aplica THEN
    v_desc := LEAST(round(v_lista * v_d.porcentaje / 100.0)::integer, v_lista);
  END IF;

  RETURN jsonb_build_object(
    'tier_id', v_tier.id,
    'precio_lista_centavos', v_lista,
    'descuento_centavos', v_desc,
    'precio_final_centavos', v_lista - v_desc,
    'moneda', COALESCE(v_tier.moneda, 'MXN'),
    'etiqueta', CASE WHEN v_aplica THEN format('%s -%s%%', v_d.nombre, v_d.porcentaje) END,
    'descuento_nombre', CASE WHEN v_aplica THEN v_d.nombre END,
    'porcentaje', CASE WHEN v_aplica THEN v_d.porcentaje END,
    'vence_el', CASE WHEN v_aplica THEN v_d.vence_el END
  );
END;
$$;

REVOKE ALL ON FUNCTION _precio_plan_para_socio(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _precio_plan_para_socio(uuid, uuid, text) TO service_role;

-- Precios de TODOS los planes activos del gym para un socio (una sola llamada
-- para pintar selectores y la tienda de la app). La puede leer el staff del gym
-- o el propio socio.
CREATE OR REPLACE FUNCTION precios_planes_para_socio(
  p_usuario_id uuid,
  p_canal text DEFAULT 'recepcion'
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_socio_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_socio_tenant FROM usuarios WHERE id = p_usuario_id;
  IF v_tenant IS NULL OR v_socio_tenant IS NULL OR v_socio_tenant <> v_tenant THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: Ese socio no es de este gimnasio';
  END IF;
  IF NOT (is_recepcionista() OR p_usuario_id = get_my_user_id()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: No puedes ver los precios de otro socio';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(_precio_plan_para_socio(p_usuario_id, t.id, p_canal))
    FROM tiers t
    WHERE t.tenant_id = v_tenant AND t.activo
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION precios_planes_para_socio(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION precios_planes_para_socio(uuid, text) TO authenticated;

-- ── 5) Otorgar / quitar (solo recepción y admin) ────────────────────────────
CREATE OR REPLACE FUNCTION otorgar_descuento_socio(
  p_usuario_id uuid,
  p_descuento_id uuid,
  p_vence_el date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_socio RECORD;
  v_d descuentos;
  v_hoy date;
  v_vence date;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden otorgar un descuento';
  END IF;

  SELECT id, tenant_id, sucursal_id, rol, nombre INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL OR v_socio.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: Ese socio no es de este gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Los descuentos son solo para socios';
  END IF;
  PERFORM _guard_sucursal_recepcion(v_socio.sucursal_id);

  SELECT * INTO v_d FROM descuentos WHERE id = p_descuento_id;
  IF v_d.id IS NULL OR v_d.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'DESCUENTO_NO_EXISTE: Ese descuento no es de este gimnasio';
  END IF;
  IF NOT v_d.activo THEN
    RAISE EXCEPTION 'DESCUENTO_INACTIVO: Ese descuento está desactivado';
  END IF;

  v_hoy := (now() AT TIME ZONE timezone_de_sucursal(v_socio.sucursal_id, v_socio.tenant_id))::date;
  v_vence := COALESCE(p_vence_el, (v_hoy + make_interval(months => v_d.vigencia_meses))::date);
  IF v_vence < v_hoy THEN
    RAISE EXCEPTION 'FECHA_INVALIDA: La fecha de vencimiento ya pasó';
  END IF;
  IF v_vence > (v_hoy + interval '24 months')::date THEN
    RAISE EXCEPTION 'FECHA_INVALIDA: El descuento no puede durar más de 24 meses';
  END IF;

  INSERT INTO socio_descuentos (tenant_id, usuario_id, descuento_id, vence_el, otorgado_por)
  VALUES (v_tenant, p_usuario_id, p_descuento_id, v_vence, get_my_user_id())
  ON CONFLICT (usuario_id) DO UPDATE
    SET descuento_id = EXCLUDED.descuento_id,
        vence_el = EXCLUDED.vence_el,
        otorgado_por = EXCLUDED.otorgado_por,
        updated_at = now();

  PERFORM _audrec_log(
    'socio.descuento_otorgar', 'socio', p_usuario_id, p_usuario_id, v_socio.nombre,
    format('Otorgó descuento %s -%s%% (vence %s)', v_d.nombre, v_d.porcentaje, to_char(v_vence, 'DD/MM/YYYY')),
    jsonb_build_object('descuento_id', v_d.id, 'nombre', v_d.nombre,
                       'porcentaje', v_d.porcentaje, 'vence_el', v_vence)
  );

  RETURN jsonb_build_object('success', true, 'descuento_id', v_d.id, 'nombre', v_d.nombre,
                            'porcentaje', v_d.porcentaje, 'vence_el', v_vence);
END;
$$;

REVOKE ALL ON FUNCTION otorgar_descuento_socio(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION otorgar_descuento_socio(uuid, uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION quitar_descuento_socio(p_usuario_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_socio RECORD;
  v_previo RECORD;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden quitar un descuento';
  END IF;

  SELECT id, tenant_id, sucursal_id, nombre INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL OR v_socio.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: Ese socio no es de este gimnasio';
  END IF;
  PERFORM _guard_sucursal_recepcion(v_socio.sucursal_id);

  DELETE FROM socio_descuentos sd
  USING descuentos d
  WHERE sd.usuario_id = p_usuario_id AND d.id = sd.descuento_id
  RETURNING d.nombre, d.porcentaje, sd.vence_el INTO v_previo;

  IF v_previo.nombre IS NULL THEN
    RETURN jsonb_build_object('success', true, 'quitado', false);
  END IF;

  PERFORM _audrec_log(
    'socio.descuento_quitar', 'socio', p_usuario_id, p_usuario_id, v_socio.nombre,
    format('Quitó el descuento %s -%s%%', v_previo.nombre, v_previo.porcentaje),
    jsonb_build_object('nombre', v_previo.nombre, 'porcentaje', v_previo.porcentaje,
                       'vence_el', v_previo.vence_el)
  );

  RETURN jsonb_build_object('success', true, 'quitado', true);
END;
$$;

REVOKE ALL ON FUNCTION quitar_descuento_socio(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION quitar_descuento_socio(uuid) TO authenticated;

-- ── 6) Motor de cobro: usa el precio con descuento ──────────────────────────
-- Copia EXACTA de 20261005260000 con 4 cambios: 3 variables nuevas, el cálculo
-- de v_monto_plan, la nota del pago del plan y 2 campos en la respuesta.
CREATE OR REPLACE FUNCTION public.gestionar_membresia_socio(p_usuario_id uuid, p_tier_id uuid, p_motivo text DEFAULT NULL::text, p_metodo_pago text DEFAULT NULL::text, p_monto_centavos integer DEFAULT NULL::integer, p_confirmar_perdida boolean DEFAULT false, p_operation_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_id uuid;
  v_actor_tenant_id uuid;
  v_socio usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_anterior_id uuid;
  v_anterior_fin timestamptz;
  v_anterior_saldo integer;
  v_anterior_tier_tipo text;
  v_anterior_es_pase boolean;
  v_anterior_sucursal_id uuid;
  v_existe_anterior boolean := false;
  v_mismo_tipo boolean := false;
  v_nuevo_fin timestamptz;
  v_nuevo_saldo integer;
  v_modo text;
  v_delta_creditos integer;
  v_membresia_id uuid;
  v_motivo_final text;
  v_monto_plan integer;
  v_cobra_inscripcion boolean := false;
  v_inscripcion integer := 0;
  v_sucursal_id uuid;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
  v_precio jsonb;
  v_desc_centavos integer := 0;
  v_desc_etiqueta text;
BEGIN
  v_actor_id := get_my_user_id();
  v_actor_tenant_id := get_my_tenant_id();
  IF v_actor_id IS NULL OR v_actor_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff (admin/recepción) puede gestionar membresías';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_actor_tenant_id, p_operation_key, 'membresia', v_actor_id,
      md5(jsonb_build_object('usuario', p_usuario_id, 'tier', p_tier_id, 'motivo', p_motivo,
                             'metodo', p_metodo_pago, 'monto', p_monto_centavos,
                             'confirmar', p_confirmar_perdida)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;
  IF v_socio.tenant_id <> v_actor_tenant_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El socio no pertenece a tu gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Solo se pueden asignar membresías a usuarios con rol miembro';
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: El tier no existe';
  END IF;
  IF v_tier.tenant_id <> v_socio.tenant_id THEN
    RAISE EXCEPTION 'TIER_TENANT_INVALIDO: El tier no pertenece al mismo gimnasio que el socio';
  END IF;
  IF NOT v_tier.activo THEN
    RAISE EXCEPTION 'TIER_INACTIVO: El tier no está activo. Activalo desde Planes antes de asignarlo';
  END IF;

  IF p_metodo_pago IS NOT NULL
     AND p_metodo_pago NOT IN ('efectivo', 'tarjeta', 'transferencia', 'cortesia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido (%)', p_metodo_pago;
  END IF;

  SELECT m.id, m.periodo_actual_fin, m.creditos_restantes, t.tipo, COALESCE(t.es_pase, false), m.sucursal_id
  INTO v_anterior_id, v_anterior_fin, v_anterior_saldo, v_anterior_tier_tipo, v_anterior_es_pase, v_anterior_sucursal_id
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada', 'expirada')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  v_existe_anterior := v_anterior_id IS NOT NULL;
  v_mismo_tipo := v_existe_anterior AND v_anterior_tier_tipo = v_tier.tipo;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  IF v_existe_anterior THEN
    PERFORM _guard_sucursal_recepcion(v_anterior_sucursal_id);
  ELSE
    PERFORM _guard_sucursal_recepcion(v_socio.sucursal_id);
  END IF;

  IF NOT v_existe_anterior THEN
    v_modo := 'alta';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;
  ELSIF v_mismo_tipo THEN
    IF v_tier.duracion_dias IS NULL THEN
      v_nuevo_fin := NULL;
      v_modo := 'renovacion';
    ELSIF NOT COALESCE(v_tier.es_pase, false)
          AND NOT COALESCE(v_anterior_es_pase, false)
          AND v_anterior_fin IS NOT NULL AND v_anterior_fin > v_now THEN
      v_nuevo_fin := v_anterior_fin + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion';
    ELSE
      v_nuevo_fin := v_now + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion_desde_hoy';
    END IF;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE COALESCE(v_anterior_saldo, 0) + COALESCE(v_tier.clases_incluidas, 0)
    END;
  ELSE
    v_modo := 'cambio_de_tipo';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;
  END IF;

  v_delta_creditos := COALESCE(v_nuevo_saldo, 0) - COALESCE(v_anterior_saldo, 0);

  IF v_modo = 'cambio_de_tipo'
     AND COALESCE(v_anterior_saldo, 0) > 0
     AND NOT COALESCE(p_confirmar_perdida, false) THEN
    RAISE EXCEPTION
      'CREDITOS_SE_PIERDEN: El socio tiene % clase(s) sin usar. Cambiar a este plan las borra. Confirmá el cambio si es lo que querés.',
      v_anterior_saldo;
  END IF;

  IF v_existe_anterior THEN
    UPDATE membresias
    SET tier_id = p_tier_id,
        status = 'activa',
        periodo_actual_inicio = v_now,
        periodo_actual_fin = v_nuevo_fin,
        creditos_restantes = v_nuevo_saldo,
        updated_at = v_now
    WHERE id = v_anterior_id;
    v_membresia_id := v_anterior_id;
  ELSE
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin, creditos_restantes
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, 'activa',
      v_now, v_nuevo_fin, v_nuevo_saldo
    )
    RETURNING id INTO v_membresia_id;
  END IF;

  v_motivo_final := COALESCE(
    NULLIF(trim(p_motivo), ''),
    format('%s — tier %s', v_modo, v_tier.slug)
  );

  IF v_modo = 'cambio_de_tipo' AND COALESCE(v_anterior_saldo, 0) > 0 THEN
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'expiracion', -v_anterior_saldo,
      NULL, format('créditos perdidos por cambio de plan (tier %s)', v_tier.slug), v_actor_id
    );
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', COALESCE(v_nuevo_saldo, 0),
      NULL, v_motivo_final, v_actor_id
    );
  ELSE
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', v_delta_creditos,
      NULL, v_motivo_final, v_actor_id
    );
  END IF;

  IF p_metodo_pago IS NOT NULL THEN
    -- Descuento por socio (p. ej. Estudiante -20%): se aplica al PLAN, nunca a la
    -- inscripción. Solo si nadie mandó un monto explícito (p_monto_centavos manda).
    IF p_monto_centavos IS NULL THEN
      v_precio := _precio_plan_para_socio(p_usuario_id, p_tier_id, 'recepcion');
      v_monto_plan := COALESCE((v_precio->>'precio_final_centavos')::integer, v_tier.precio_centavos, 0);
      v_desc_centavos := COALESCE((v_precio->>'descuento_centavos')::integer, 0);
      v_desc_etiqueta := v_precio->>'etiqueta';
    ELSE
      v_monto_plan := p_monto_centavos;
    END IF;
    SELECT sucursal_id INTO v_sucursal_id FROM membresias WHERE id = v_membresia_id;

    IF v_monto_plan > 0 THEN
      INSERT INTO pagos (
        tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
        concepto, monto_centavos, moneda, metodo, notas, cobrado_por
      ) VALUES (
        v_socio.tenant_id, v_sucursal_id, p_usuario_id, v_membresia_id, p_tier_id,
        CASE WHEN v_tier.tipo IN ('creditos', 'hibrido') THEN 'paquete' ELSE 'plan' END,
        v_monto_plan, COALESCE(v_tier.moneda, 'MXN'), p_metodo_pago,
        v_motivo_final || COALESCE(' · ' || v_desc_etiqueta, ''), v_actor_id
      );
    END IF;

    v_inscripcion := COALESCE(v_tier.inscripcion_centavos, 0);
    v_cobra_inscripcion := v_inscripcion > 0
      AND v_socio.inscripcion_pagada_at IS NULL
      AND v_modo = 'alta'
      AND NOT EXISTS (
        SELECT 1 FROM membresias
        WHERE usuario_id = p_usuario_id AND id <> v_membresia_id
      );

    IF v_cobra_inscripcion THEN
      INSERT INTO pagos (
        tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
        concepto, monto_centavos, moneda, metodo, notas, cobrado_por
      ) VALUES (
        v_socio.tenant_id, v_sucursal_id, p_usuario_id, v_membresia_id, p_tier_id,
        'inscripcion', v_inscripcion, COALESCE(v_tier.moneda, 'MXN'), p_metodo_pago,
        'inscripción', v_actor_id
      );
      UPDATE usuarios SET inscripcion_pagada_at = v_now WHERE id = p_usuario_id;
    END IF;
  END IF;

  UPDATE usuarios
  SET membresia_tier = v_tier.slug,
      membresia_activa_id = v_membresia_id,
      status = CASE WHEN status = 'pendiente_pago' THEN 'activo' ELSE status END
  WHERE id = p_usuario_id;

  v_result := jsonb_build_object(
    'success', true,
    'membresia_id', v_membresia_id,
    'modo', v_modo,
    'tier_slug', v_tier.slug,
    'tier_nombre', v_tier.nombre,
    'tier_tipo', v_tier.tipo,
    'periodo_actual_fin', v_nuevo_fin,
    'creditos_restantes', v_nuevo_saldo,
    'delta_creditos', v_delta_creditos,
    'cobro_registrado', p_metodo_pago IS NOT NULL,
    'monto_plan_centavos', COALESCE(v_monto_plan, 0),
    'descuento_centavos', v_desc_centavos,
    'descuento_etiqueta', v_desc_etiqueta,
    'inscripcion_centavos', CASE WHEN v_cobra_inscripcion THEN v_inscripcion ELSE 0 END
  );
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_actor_tenant_id, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$function$;
