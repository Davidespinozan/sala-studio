-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- FIX — la huella NUNCA se guardaba (ni el check-in por huella funcionaba): la
-- bitácora tumbaba la transacción entera.
-- ────────────────────────────────────────────────────────────────────────────
-- `completar_enrolamiento_huella` y `check_in_por_huella` las llama el AGENTE del
-- lector vía Netlify con el rol `service_role` — SIN JWT de usuario. Ambas
-- terminaban llamando `_audrec_log(...)`, que resuelve al actor con
-- `auth.uid()` y, si no lo encuentra, hace `RAISE EXCEPTION 'NO_AUTORIZADO'`.
--
-- Como son SECURITY DEFINER, todo corre en UNA transacción: el RAISE de la
-- bitácora revertía el INSERT de la huella (y el UPDATE del check-in). Resultado:
--   • enrolar → `credenciales_biometricas` quedaba vacía, `completado_at` NULL,
--     el agente reintentaba en bucle y la pantalla decía "la toma venció".
--   • check-in por huella → jamás habría marcado la entrada.
--
-- El self-test de la migración original NO lo cazó porque SIMULA un JWT
-- (`set_config('request.jwt.claims', …)`); en producción el agente entra sin JWT.
--
-- PRINCIPIO DEL FIX: la bitácora es SECUNDARIA; la operación biométrica es
-- esencial. Una falla al escribir bitácora nunca debe revertir un enrolamiento o
-- un check-in válido.
--   • Enrolar: se atribuye al recepcionista que ABRIÓ la toma (`solicitado_por`,
--     que sí es recepcionista/admin) y se escribe DIRECTO (sin _audrec_log). Best
--     effort: si algo falla, la huella queda guardada igual.
--   • Check-in por huella: lo hace el APARATO, no un operador. Se envuelve
--     `_audrec_log` en un bloque que se traga el error. La entrada real ya queda
--     en `reservas` (check_in_method='huella').
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1) Enrolar: guardar la huella sin que la bitácora lo tumbe ───────────────
CREATE OR REPLACE FUNCTION completar_enrolamiento_huella(
  p_token text,
  p_enrolamiento_id uuid,
  p_plantilla_cifrada text,
  p_formato text DEFAULT 'iso19794-2',
  p_calidad smallint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lector lectores_biometricos;
  v_enrol enrolamientos_huella;
  v_socio usuarios;
  v_blob bytea;
  v_id uuid;
BEGIN
  SELECT * INTO v_lector FROM lectores_biometricos
  WHERE token_hash = _hash_token_lector(p_token) AND activo;

  IF v_lector.id IS NULL THEN
    RAISE EXCEPTION 'LECTOR_DESCONOCIDO: Ese lector no está dado de alta';
  END IF;

  SELECT * INTO v_enrol FROM enrolamientos_huella
  WHERE id = p_enrolamiento_id AND tenant_id = v_lector.tenant_id;

  IF v_enrol.id IS NULL THEN
    RAISE EXCEPTION 'ENROLAMIENTO_NO_EXISTE: Esa toma de huella no existe';
  END IF;

  -- La cita vencida no vale: es un permiso para escribir una huella, y los
  -- permisos no pueden quedar vivos "por si acaso".
  IF v_enrol.completado_at IS NOT NULL OR v_enrol.cancelado_at IS NOT NULL
     OR v_enrol.expira_at <= now() THEN
    RAISE EXCEPTION 'ENROLAMIENTO_VENCIDO: Esa toma de huella ya no está abierta. Volvé a empezar';
  END IF;

  BEGIN
    v_blob := decode(COALESCE(p_plantilla_cifrada, ''), 'base64');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'PLANTILLA_INVALIDA: La captura llegó rota';
  END;

  -- 12 (iv) + 16 (tag) + algo. Menos que eso no es una huella cifrada.
  IF octet_length(v_blob) < 32 THEN
    RAISE EXCEPTION 'PLANTILLA_INVALIDA: La captura llegó vacía o rota';
  END IF;

  -- Una captura mala condena al socio a que el lector no lo reconozca nunca. Es
  -- mejor pedirle el dedo otra vez ahora, que tenerlo peleándose con la puerta.
  IF p_calidad IS NOT NULL AND p_calidad < 60 THEN
    RAISE EXCEPTION 'CALIDAD_BAJA: La huella salió borrosa (calidad % de 100). Limpiá el lector y tomala de nuevo', p_calidad;
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = v_enrol.usuario_id;

  INSERT INTO credenciales_biometricas (
    tenant_id, usuario_id, dedo, plantilla, formato, calidad, capturada_con,
    consentimiento_at, enrolado_por
  ) VALUES (
    v_lector.tenant_id, v_enrol.usuario_id, v_enrol.dedo,
    v_blob, COALESCE(p_formato, 'iso19794-2'), p_calidad,
    trim(COALESCE(v_lector.marca, '') || ' ' || COALESCE(v_lector.modelo, '')),
    v_enrol.consentimiento_at, v_enrol.solicitado_por
  )
  RETURNING id INTO v_id;

  UPDATE enrolamientos_huella SET completado_at = now() WHERE id = v_enrol.id;

  -- Bitácora BEST-EFFORT. La llama el service_role (agente), SIN JWT, así que
  -- _audrec_log (que saca el actor de auth.uid()) tronaría y revertiría el
  -- guardado — era EL bug. Atribuimos al recepcionista que abrió la toma y
  -- escribimos directo; si algo falla, la huella queda guardada igual.
  BEGIN
    INSERT INTO auditoria_recepcion (
      tenant_id, actor_id, actor_nombre, actor_rol,
      accion, entidad, entidad_id, socio_id, socio_nombre, resumen, detalle
    )
    SELECT
      v_lector.tenant_id, sp.id, COALESCE(sp.nombre, sp.email, 'Recepción'), sp.rol,
      'socio.huella_enrolar', 'socio', v_enrol.usuario_id, v_enrol.usuario_id,
      COALESCE(v_socio.nombre, v_socio.email),
      'Registró la huella del socio (con su consentimiento).',
      jsonb_build_object('dedo', v_enrol.dedo, 'lector', v_lector.nombre, 'calidad', p_calidad)
    FROM usuarios sp
    WHERE sp.id = v_enrol.solicitado_por
      AND sp.rol IN ('recepcionista', 'admin');
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- la bitácora es secundaria; nunca revierte el guardado de la huella
  END;

  RETURN jsonb_build_object('success', true, 'credencial_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION completar_enrolamiento_huella(text, uuid, text, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION completar_enrolamiento_huella(text, uuid, text, text, smallint) FROM anon;
REVOKE ALL ON FUNCTION completar_enrolamiento_huella(text, uuid, text, text, smallint) FROM authenticated;
GRANT EXECUTE ON FUNCTION completar_enrolamiento_huella(text, uuid, text, text, smallint) TO service_role;


-- ── 2) Check-in por huella: idem, que la bitácora no tumbe la entrada ────────
CREATE OR REPLACE FUNCTION check_in_por_huella(
  p_token text,
  p_usuario_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lector lectores_biometricos;
  v_socio usuarios;
  v_reserva reservas;
  v_recurso recursos;
  v_clase clases;
  v_ventana integer;
BEGIN
  SELECT * INTO v_lector
  FROM lectores_biometricos
  WHERE token_hash = _hash_token_lector(p_token);

  IF v_lector.id IS NULL THEN
    RAISE EXCEPTION 'LECTOR_DESCONOCIDO: Ese lector no está dado de alta';
  END IF;

  IF NOT v_lector.activo THEN
    RAISE EXCEPTION 'LECTOR_INACTIVO: Ese lector está desactivado';
  END IF;

  -- Señal de vida: la usa el admin para saber si el aparato sigue conectado.
  UPDATE lectores_biometricos SET ultimo_visto_at = now() WHERE id = v_lector.id;

  -- El agente dice "es el socio X". Le creemos solo si X tiene una huella VIVA en
  -- ESTE gym: si no, un agente comprometido podría hacer entrar a cualquiera.
  SELECT u.* INTO v_socio
  FROM usuarios u
  WHERE u.id = p_usuario_id
    AND u.tenant_id = v_lector.tenant_id
    AND EXISTS (
      SELECT 1 FROM credenciales_biometricas c
      WHERE c.usuario_id = u.id
        AND c.tenant_id = v_lector.tenant_id
        AND c.revocada_at IS NULL
    );

  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'HUELLA_NO_RECONOCIDA: Esa huella no está registrada en este gimnasio';
  END IF;

  v_ventana := ventana_check_in_min(v_lector.tenant_id);

  -- ¿Qué reserva está entrando? La suya, confirmada, dentro de la ventana del gym,
  -- y en la sede donde está parado el lector. Si hay varias (clases pegadas), la
  -- más cercana al momento en que apoyó el dedo.
  SELECT r.* INTO v_reserva
  FROM reservas r
  JOIN recursos rec ON rec.id = r.recurso_id
  WHERE r.tenant_id = v_lector.tenant_id
    AND r.usuario_id = v_socio.id
    AND r.status = 'confirmada'
    AND p_at >= r.slot_inicio - (v_ventana || ' minutes')::interval
    AND p_at <= r.slot_fin + (v_ventana * 2 || ' minutes')::interval
    AND (
      v_lector.sucursal_id IS NULL
      OR rec.sucursal_id = v_lector.sucursal_id
    )
  ORDER BY abs(extract(epoch FROM (r.slot_inicio - p_at)))
  LIMIT 1;

  IF v_reserva.id IS NULL THEN
    -- No es un error del socio: es que no tiene clase ahora. Recepción decide qué
    -- hacer (crearle la reserva en el mostrador, por ejemplo).
    RAISE EXCEPTION 'SIN_RESERVA: % no tiene ninguna reserva para este momento',
      COALESCE(v_socio.nombre, v_socio.email);
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = p_at,
      check_in_by = NULL,          -- no hay persona detrás: lo hizo el aparato
      check_in_method = 'huella'
  WHERE id = v_reserva.id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = v_reserva.clase_id;

  -- Bitácora BEST-EFFORT: el check-in por huella lo hace el APARATO (service_role,
  -- sin JWT). _audrec_log sacaría el actor de auth.uid() (null) y tronaría,
  -- revirtiendo la entrada. La entrada real ya quedó en reservas
  -- (check_in_method='huella'); si la bitácora no se puede escribir, no pasa nada.
  BEGIN
    PERFORM _audrec_log(
      'checkin.huella', 'reserva', v_reserva.id, v_socio.id, v_socio.nombre,
      format('Entró con huella por el lector "%s".', v_lector.nombre),
      jsonb_build_object('lector_id', v_lector.id, 'lector', v_lector.nombre)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- la bitácora es secundaria; nunca revierte la entrada
  END;

  RETURN jsonb_build_object(
    'success', true,
    'socio', jsonb_build_object(
      'id', v_socio.id,
      'nombre', v_socio.nombre,
      'avatar_url', v_socio.avatar_url
    ),
    'reserva_id', v_reserva.id,
    'clase', COALESCE(v_clase.nombre, v_recurso.nombre),
    'hora', to_char(v_reserva.slot_inicio, 'HH24:MI')
  );
END;
$$;

REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION check_in_por_huella(text, uuid, timestamptz) TO service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA. Prueba SIN JWT (como el service_role del agente):
--   1) reproduce la causa raíz: _audrec_log truena sin actor.
--   2) el fix: el audit atribuido al recepcionista SÍ entra (y se revierte).
-- No deja nada escrito.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_fix_huella()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid := '566dd1b5-61fe-414a-8ae5-0eee15eb610f';
  v_socio uuid;
  v_recep uuid;
  v_recep_nombre text;
  v_recep_rol text;
  v_bug text;
  v_fix text;
  v_n int := -1;
BEGIN
  SELECT id INTO v_socio FROM usuarios
    WHERE tenant_id = v_tenant AND nombre = 'Julieta Garcia' LIMIT 1;
  SELECT id, COALESCE(nombre, email, 'Recepción'), rol
    INTO v_recep, v_recep_nombre, v_recep_rol
    FROM usuarios
    WHERE tenant_id = v_tenant AND rol IN ('recepcionista', 'admin')
    ORDER BY (rol = 'recepcionista') DESC LIMIT 1;

  -- 1) El bug: sin JWT, _audrec_log truena → revertía TODO el enrolamiento.
  BEGIN
    PERFORM _audrec_log('socio.huella_enrolar', 'socio', v_socio, v_socio, 'x', 'y', '{}'::jsonb);
    v_bug := '❌ no tronó (inesperado)';
  EXCEPTION WHEN OTHERS THEN
    v_bug := '✅ truena sin JWT → ' || SQLERRM;
  END;

  -- 2) El fix: audit atribuido al recepcionista entra sin JWT (y se revierte).
  BEGIN
    INSERT INTO auditoria_recepcion (
      tenant_id, actor_id, actor_nombre, actor_rol,
      accion, entidad, entidad_id, socio_id, socio_nombre, resumen, detalle
    ) VALUES (
      v_tenant, v_recep, v_recep_nombre, v_recep_rol,
      'socio.huella_enrolar', 'socio', v_socio, v_socio, 'diag', 'diag', '{}'::jsonb
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE EXCEPTION 'UNDO';  -- deshace la fila de prueba
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'UNDO' THEN
      v_fix := '✅ insertó ' || v_n || ' fila como ' || v_recep_nombre
               || ' (' || v_recep_rol || '), revertida';
    ELSE
      v_fix := '❌ falló: ' || SQLERRM;
    END IF;
  END;

  prueba := '1. bitácora sin JWT (causa raíz)';                 resultado := v_bug; RETURN NEXT;
  prueba := '2. audit atribuido al recepcionista (el fix)';     resultado := v_fix; RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_fix_huella();
DROP FUNCTION _diag_fix_huella();