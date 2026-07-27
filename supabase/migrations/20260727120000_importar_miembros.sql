-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- IMPORTAR MIEMBROS — alta masiva de socios migrados de otro sistema.
-- ────────────────────────────────────────────────────────────────────────────
-- Un gym que llega de otra plataforma (ekko, Mindbody, Excel…) trae su padrón:
-- nombre, email, teléfono, su plan, cuándo vence y cuántas clases le quedan. Esto
-- los da de alta de una:
--
--   · usuario rol='miembro', status='activo', SIN auth (auth_id NULL): reclama su
--     login después (mismo patrón que "invitado por admin sin signup"). Recepción
--     ya los puede pasar/atender de inmediato.
--   · membresía 'activa' con el VENCIMIENTO del sistema viejo (no lo recalcula por
--     la duración del tier) y SIN cobrar (ya pagaron allá). Si es paquete, siembra
--     los créditos y el ledger.
--
-- Resiliente por fila: una fila mala (sin nombre, email repetido, plan inválido)
-- se reporta y NO tumba el lote (BEGIN/EXCEPTION dentro del loop).
--
-- Solo la llama el servidor (service_role) después de validar que quien importa es
-- admin del tenant. Por eso REVOKE de todo lo demás.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION importar_miembros(
  p_tenant_id uuid,
  p_rows jsonb   -- [{ nombre, email, telefono, tier_id, vencimiento, creditos }]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_nombre text;
  v_email text;
  v_tel text;
  v_tier tiers;
  v_venc timestamptz;
  v_creditos integer;
  v_usuario_id uuid;
  v_membresia_id uuid;
  v_existe uuid;
  v_creados int := 0;
  v_omitidos int := 0;
  v_errores int := 0;
  v_detalle jsonb := '[]'::jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'TENANT_NULL'; END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    BEGIN
      v_nombre := NULLIF(btrim(v_row->>'nombre'), '');
      v_email  := NULLIF(lower(btrim(v_row->>'email')), '');
      v_tel    := NULLIF(btrim(v_row->>'telefono'), '');

      -- Nombre y email son obligatorios (usuarios.email es NOT NULL; el email
      -- ancla el reclamo de cuenta futuro).
      IF v_nombre IS NULL THEN
        v_errores := v_errores + 1;
        v_detalle := v_detalle || jsonb_build_object('email', v_row->>'email', 'nombre', v_row->>'nombre', 'resultado', 'error', 'motivo', 'Falta el nombre');
        CONTINUE;
      END IF;
      IF v_email IS NULL THEN
        v_errores := v_errores + 1;
        v_detalle := v_detalle || jsonb_build_object('email', NULL, 'nombre', v_nombre, 'resultado', 'error', 'motivo', 'Falta el email');
        CONTINUE;
      END IF;

      -- El plan debe ser del tenant y estar activo.
      SELECT * INTO v_tier FROM tiers WHERE id = NULLIF(v_row->>'tier_id','')::uuid;
      IF v_tier.id IS NULL OR v_tier.tenant_id <> p_tenant_id THEN
        v_errores := v_errores + 1;
        v_detalle := v_detalle || jsonb_build_object('email', v_email, 'nombre', v_nombre, 'resultado', 'error', 'motivo', 'Plan inválido');
        CONTINUE;
      END IF;

      -- Dedup por email dentro del tenant → se omite (no se pisa lo que ya hay).
      SELECT id INTO v_existe FROM usuarios
      WHERE tenant_id = p_tenant_id AND lower(email) = v_email
      LIMIT 1;
      IF v_existe IS NOT NULL THEN
        v_omitidos := v_omitidos + 1;
        v_detalle := v_detalle || jsonb_build_object('email', v_email, 'nombre', v_nombre, 'resultado', 'omitido', 'motivo', 'Ya existe en tu gimnasio');
        CONTINUE;
      END IF;

      -- Vencimiento del sistema viejo. Si no viene, se estima por el periodo del
      -- tier (+1 mes/año) para no dejar la membresía sin fin.
      v_venc := NULLIF(v_row->>'vencimiento','')::timestamptz;
      IF v_venc IS NULL THEN
        v_venc := now() + CASE WHEN v_tier.periodo = 'anual' THEN interval '1 year' ELSE interval '1 month' END;
      END IF;

      v_creditos := NULLIF(v_row->>'creditos','')::integer;

      -- 1) Usuario (sin auth: reclama su login después).
      INSERT INTO usuarios (tenant_id, nombre, email, telefono, rol, status, membresia_tier)
      VALUES (p_tenant_id, v_nombre, v_email, v_tel, 'miembro', 'activo', v_tier.slug)
      RETURNING id INTO v_usuario_id;

      -- 2) Membresía activa con el vencimiento traído (sin cobro).
      INSERT INTO membresias (
        tenant_id, usuario_id, tier_id, status,
        periodo_actual_inicio, periodo_actual_fin, creditos_restantes
      )
      VALUES (
        p_tenant_id, v_usuario_id, v_tier.id, 'activa',
        now(), v_venc,
        CASE WHEN v_tier.tipo IN ('creditos','hibrido') THEN COALESCE(v_creditos, 0) ELSE NULL END
      )
      RETURNING id INTO v_membresia_id;

      -- Cache de la membresía activa en el usuario.
      UPDATE usuarios SET membresia_activa_id = v_membresia_id WHERE id = v_usuario_id;

      -- 3) Paquete → semilla del ledger (carga inicial), coherente con reservar.
      IF v_tier.tipo IN ('creditos','hibrido') AND COALESCE(v_creditos,0) > 0 THEN
        INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo)
        VALUES (v_membresia_id, p_tenant_id, 'alta', v_creditos, 'Importación');
      END IF;

      v_creados := v_creados + 1;
      v_detalle := v_detalle || jsonb_build_object('email', v_email, 'nombre', v_nombre, 'resultado', 'creado', 'motivo', NULL);

    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores + 1;
      v_detalle := v_detalle || jsonb_build_object('email', v_email, 'nombre', v_nombre, 'resultado', 'error', 'motivo', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'creados', v_creados, 'omitidos', v_omitidos, 'errores', v_errores, 'detalle', v_detalle
  );
END; $$;

-- Solo el servidor (service_role): fuera de PUBLIC/anon/authenticated.
REVOKE ALL ON FUNCTION importar_miembros(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA y NO deja datos (corre y se revierte).
-- Copiá de acá abajo en una ejecución aparte si querés verificarlo:
--
--   BEGIN;
--   SELECT importar_miembros(
--     (SELECT id FROM tenants WHERE slug = 'healthyspace'),
--     jsonb_build_array(
--       jsonb_build_object(
--         'nombre','Prueba Import','email','prueba.import@example.com','telefono','',
--         'tier_id',(SELECT id FROM tiers WHERE tenant_id=(SELECT id FROM tenants WHERE slug='healthyspace') AND activo ORDER BY orden LIMIT 1),
--         'vencimiento','2027-01-01','creditos',''
--       ),
--       jsonb_build_object('nombre','','email','x@x.com','telefono','','tier_id','','vencimiento','','creditos','')
--     )
--   ) AS resultado;   -- esperado: creados=1, errores=1 (fila sin nombre/plan)
--   ROLLBACK;
-- ════════════════════════════════════════════════════════════════════════════
