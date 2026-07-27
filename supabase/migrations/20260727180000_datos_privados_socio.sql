-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- FICHA DE DATOS DEL SOCIO — nacimiento, sexo, domicilio (para edad, cumpleaños,
-- segmentación). Patrón tomado de ekko: tabla APARTE, no columnas en `usuarios`.
-- ────────────────────────────────────────────────────────────────────────────
-- Los datos personales sensibles NO van en `usuarios` (esa tabla tiene la trampa
-- de la lista blanca: columna nueva nace ilegible y rompe queries). Van en una
-- tabla propia con RLS más estricta. Habilita: edad calculada, felicitación de
-- cumpleaños y segmentar campañas por sexo/edad.
--
-- También extiende importar_miembros para traer fecha_nacimiento y domicilio del
-- CSV (numa los trae). El sexo no viene en el export → se captura a mano.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS usuarios_datos_privados (
  usuario_id       uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fecha_nacimiento date,
  sexo             text CHECK (sexo IS NULL OR sexo IN ('femenino', 'masculino', 'otro')),
  domicilio        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS datos_privados_tenant_idx ON usuarios_datos_privados (tenant_id);
-- Cumpleaños: buscar por mes/día. (Se calcula al vuelo; el índice ayuda por tenant.)

DROP TRIGGER IF EXISTS datos_privados_set_updated_at ON usuarios_datos_privados;
CREATE TRIGGER datos_privados_set_updated_at
  BEFORE UPDATE ON usuarios_datos_privados
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Seguridad ───────────────────────────────────────────────────────────────
ALTER TABLE usuarios_datos_privados ENABLE ROW LEVEL SECURITY;

-- Staff (admin/recepción) del gym: leer y editar la ficha de sus socios.
DROP POLICY IF EXISTS datos_privados_staff ON usuarios_datos_privados;
CREATE POLICY datos_privados_staff ON usuarios_datos_privados
  FOR ALL TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- El socio: ver SU propia ficha (no la de otros).
DROP POLICY IF EXISTS datos_privados_socio ON usuarios_datos_privados;
CREATE POLICY datos_privados_socio ON usuarios_datos_privados
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND usuario_id = get_my_user_id());

-- ════════════════════════════════════════════════════════════════════════════
-- importar_miembros v3 — ahora acepta fecha_nacimiento y domicilio (del CSV) y
-- los guarda en la ficha. Resto igual que la v2 (sin correo, dedup, etc.).
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION importar_miembros(
  p_tenant_id uuid,
  p_rows jsonb   -- [{ nombre, email, telefono, tier_id, vencimiento, creditos, nacimiento, domicilio }]
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
  v_sin_correo boolean;
  v_tier tiers;
  v_venc timestamptz;
  v_creditos integer;
  v_nacimiento date;
  v_domicilio text;
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
      v_sin_correo := false;

      IF v_nombre IS NULL THEN
        v_errores := v_errores + 1;
        v_detalle := v_detalle || jsonb_build_object('email', v_row->>'email', 'nombre', v_row->>'nombre', 'resultado', 'error', 'motivo', 'Falta el nombre');
        CONTINUE;
      END IF;

      IF v_email IS NULL THEN
        v_email := 'sincorreo-' || replace(gen_random_uuid()::text, '-', '') || '@sin-correo.local';
        v_sin_correo := true;
      END IF;

      SELECT * INTO v_tier FROM tiers WHERE id = NULLIF(v_row->>'tier_id','')::uuid;
      IF v_tier.id IS NULL OR v_tier.tenant_id <> p_tenant_id THEN
        v_errores := v_errores + 1;
        v_detalle := v_detalle || jsonb_build_object('email', v_row->>'email', 'nombre', v_nombre, 'resultado', 'error', 'motivo', 'Plan inválido');
        CONTINUE;
      END IF;

      IF v_sin_correo THEN
        IF v_tel IS NOT NULL THEN
          SELECT id INTO v_existe FROM usuarios WHERE tenant_id = p_tenant_id AND telefono = v_tel LIMIT 1;
        ELSE
          v_existe := NULL;
        END IF;
      ELSE
        SELECT id INTO v_existe FROM usuarios WHERE tenant_id = p_tenant_id AND lower(email) = v_email LIMIT 1;
      END IF;
      IF v_existe IS NOT NULL THEN
        v_omitidos := v_omitidos + 1;
        v_detalle := v_detalle || jsonb_build_object('email', v_row->>'email', 'nombre', v_nombre, 'resultado', 'omitido', 'motivo', 'Ya existe en tu gimnasio');
        CONTINUE;
      END IF;

      v_venc := NULLIF(v_row->>'vencimiento','')::timestamptz;
      IF v_venc IS NULL THEN
        v_venc := now() + CASE WHEN v_tier.periodo = 'anual' THEN interval '1 year' ELSE interval '1 month' END;
      END IF;
      v_creditos := NULLIF(v_row->>'creditos','')::integer;

      -- Nacimiento: cast defensivo (una fecha mala NO pierde al socio).
      BEGIN
        v_nacimiento := NULLIF(v_row->>'nacimiento','')::date;
      EXCEPTION WHEN others THEN
        v_nacimiento := NULL;
      END;
      v_domicilio := NULLIF(btrim(v_row->>'domicilio'), '');

      INSERT INTO usuarios (tenant_id, nombre, email, telefono, rol, status, membresia_tier, notas_admin)
      VALUES (
        p_tenant_id, v_nombre, v_email, v_tel, 'miembro', 'activo', v_tier.slug,
        CASE WHEN v_sin_correo
          THEN 'Importado SIN correo. Pídele su email y actualízalo en la ficha para que pueda activar su cuenta.'
          ELSE NULL END
      )
      RETURNING id INTO v_usuario_id;

      -- Ficha de datos (si el CSV trajo nacimiento o domicilio).
      IF v_nacimiento IS NOT NULL OR v_domicilio IS NOT NULL THEN
        INSERT INTO usuarios_datos_privados (usuario_id, tenant_id, fecha_nacimiento, domicilio)
        VALUES (v_usuario_id, p_tenant_id, v_nacimiento, v_domicilio)
        ON CONFLICT (usuario_id) DO NOTHING;
      END IF;

      INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
      VALUES (
        p_tenant_id, v_usuario_id, v_tier.id, 'activa', now(), v_venc,
        CASE WHEN v_tier.tipo IN ('creditos','hibrido') THEN COALESCE(v_creditos, 0) ELSE NULL END
      )
      RETURNING id INTO v_membresia_id;

      UPDATE usuarios SET membresia_activa_id = v_membresia_id WHERE id = v_usuario_id;

      IF v_tier.tipo IN ('creditos','hibrido') AND COALESCE(v_creditos,0) > 0 THEN
        INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo)
        VALUES (v_membresia_id, p_tenant_id, 'alta', v_creditos, 'Importación');
      END IF;

      v_creados := v_creados + 1;
      v_detalle := v_detalle || jsonb_build_object(
        'email', CASE WHEN v_sin_correo THEN NULL ELSE v_email END,
        'nombre', v_nombre, 'resultado', 'creado',
        'motivo', CASE WHEN v_sin_correo THEN 'sin correo' ELSE NULL END
      );

    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores + 1;
      v_detalle := v_detalle || jsonb_build_object('email', v_row->>'email', 'nombre', v_nombre, 'resultado', 'error', 'motivo', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('creados', v_creados, 'omitidos', v_omitidos, 'errores', v_errores, 'detalle', v_detalle);
END; $$;

REVOKE ALL ON FUNCTION importar_miembros(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA (verifica tabla, policies y que la ficha se guarda).
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_tenant uuid; v_tier uuid; v_res jsonb; v_uid uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: sin tenant.'; RETURN; END IF;

  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, activo, orden)
  VALUES (v_tenant, 'ficha-test', 'Ficha Test', 'tiempo', 100000, 'MXN', 30, true, 999)
  RETURNING id INTO v_tier;

  v_res := importar_miembros(v_tenant, jsonb_build_array(
    jsonb_build_object('nombre','Ficha Test','email','ficha.test@example.com','telefono','','tier_id',v_tier::text,
                       'vencimiento','2026-12-31','creditos','','nacimiento','1993-05-25','domicilio','Calle Falsa 123')
  ));

  IF (v_res->>'creados')::int <> 1 THEN RAISE EXCEPTION 'TEST FALLO: no se creó (%).', v_res::text; END IF;

  SELECT usuario_id INTO v_uid FROM usuarios_datos_privados
  WHERE tenant_id = v_tenant AND fecha_nacimiento = DATE '1993-05-25' AND domicilio = 'Calle Falsa 123';
  IF v_uid IS NULL THEN RAISE EXCEPTION 'TEST FALLO: la ficha (nacimiento/domicilio) no se guardó.'; END IF;

  RAISE EXCEPTION 'ROLLBACK_OK_FICHA';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_OK_FICHA' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT
  'usuarios_datos_privados + RLS + importar_miembros v3' AS prueba,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='usuarios_datos_privados') AS tabla_ok,
  (SELECT count(*) FROM pg_policies WHERE tablename='usuarios_datos_privados') AS policies_esperado_2;
