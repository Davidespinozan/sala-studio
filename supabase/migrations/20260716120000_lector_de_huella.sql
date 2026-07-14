-- ============================================================================
-- LECTOR DE HUELLA — la huella es del GYM, no del aparato
-- ----------------------------------------------------------------------------
-- DECISIÓN CENTRAL: la plantilla de la huella se guarda EN SALA, cifrada.
--
-- El lector USB es un ESCÁNER: captura y nada más. Quien manda es SALA.
-- ¿Por qué así y no dejando las huellas adentro del aparato?
--   · Si el lector se rompe, el gym no pierde los 300 enrolamientos.
--   · Dos sedes, dos lectores, un solo enrolamiento.
--   · Cuando el socio revoca su huella, se borra DE VERDAD, en un solo lugar.
--   · El gym puede cambiar de marca de lector sin volver a enrolar a nadie.
--
-- Cómo entra la huella si el navegador no puede leer un USB (no puede: ningún
-- navegador expone sensores biométricos):
--
--   [lector USB] → [agente local en la compu de recepción] → [Netlify] → [SALA]
--
--   · El AGENTE es un programita que corre en la compu del mostrador. Habla con
--     el lector (driver del fabricante) y con nosotros (HTTPS + token del lector).
--   · Cifra/descifra pasa en NETLIFY, no acá: Postgres nunca ve una huella en
--     claro. Lo que se guarda en `plantilla` es un blob AES-GCM que sin la llave
--     (que vive en Netlify, no en la base) no le sirve a nadie.
--   · El agente COMPARA localmente contra las plantillas que se baja
--     (sincronizar_plantillas). El motor de comparación lo trae el driver del
--     lector; montar otro en la nube sería una pieza más sin ganar nada.
--
-- Y la huella NO es una puerta nueva: dispara el MISMO check-in que el QR, con
-- las mismas reglas (ventana del gym, sede del lector, reserva confirmada).
-- Sin reserva, no se entra. Convive con QR y manual: si el lector se rompe o el
-- socio tiene el dedo lastimado, el gym sigue operando.
--
-- La huella es DATO SENSIBLE (LFPDPPP). Por eso, en esta migración:
--   · sin consentimiento expreso del socio, la base se niega a enrolar;
--   · la columna `plantilla` está REVOCADA para `authenticated`: ni el admin del
--     gym puede leerla por la API. Solo el servidor, y sale cifrada;
--   · el socio puede revocarla él mismo desde su app.
-- ============================================================================

-- ── 0) Los restos del primer intento ────────────────────────────────────────
-- La primera versión de esta migración (la que dejaba las huellas adentro del
-- aparato) alcanzó a crear sus tablas antes de fallar en el self-test. Con la
-- forma vieja: `device_user_id`, sin `dedo`, sin `plantilla`. Y como abajo usamos
-- CREATE TABLE IF NOT EXISTS, Postgres las encontraría y no las tocaría — la
-- migración fallaría con "column dedo does not exist".
--
-- Las tiramos. Ningún gym tiene un lector dado de alta todavía: lo único que se
-- pierde son los tokens de mis propias pruebas.
DROP FUNCTION IF EXISTS check_in_por_huella(text, text, timestamptz);
DROP FUNCTION IF EXISTS enrolar_huella_socio(uuid, text, boolean);
DROP FUNCTION IF EXISTS revocar_huella_socio(uuid);
DROP TABLE IF EXISTS enrolamientos_huella CASCADE;
DROP TABLE IF EXISTS credenciales_biometricas CASCADE;
DROP TABLE IF EXISTS lectores_biometricos CASCADE;


-- ── 1) El check-in ahora puede venir de una huella ──────────────────────────
ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_check_in_method_check;
ALTER TABLE reservas ADD CONSTRAINT reservas_check_in_method_check
  CHECK (check_in_method IS NULL OR check_in_method IN ('qr', 'manual', 'huella'));

COMMENT ON COLUMN reservas.check_in_method IS
  'Cómo entró el socio: qr (escaneó su código), huella (lector del gym) o manual '
  '(recepción a mano). NULL = todavía no hizo check-in.';


-- ── 0b) El hash del token del lector, en un solo lugar ──────────────────────
-- pgcrypto vive en el esquema `extensions` (así lo instala Supabase), y nuestras
-- funciones fijan search_path = public: sin calificar, digest() no resolvería.
CREATE OR REPLACE FUNCTION _hash_token_lector(p_token text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(extensions.digest(COALESCE(p_token, ''), 'sha256'), 'hex');
$$;

REVOKE ALL ON FUNCTION _hash_token_lector(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION _hash_token_lector(text) FROM anon;
REVOKE ALL ON FUNCTION _hash_token_lector(text) FROM authenticated;


-- ── 1) Los lectores del gym ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lectores_biometricos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- La sede donde está físicamente. Un lector de la sede A no puede checar a
  -- alguien que reservó en la sede B: es imposible, no estuvo ahí.
  sucursal_id uuid REFERENCES sucursales(id) ON DELETE SET NULL,

  nombre text NOT NULL,
  -- Informativos: sirven para soporte ("¿qué tienen enchufado?"), no para la
  -- lógica. El sistema no depende de la marca.
  marca text,
  modelo text,

  -- El agente se autentica con un token. Guardamos el HASH, nunca el token: si
  -- se filtra la base, nadie puede hacerse pasar por el lector del gym.
  token_hash text NOT NULL,

  activo boolean NOT NULL DEFAULT true,
  ultimo_visto_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lectores_token_unico ON lectores_biometricos (token_hash);
CREATE INDEX IF NOT EXISTS lectores_tenant_idx ON lectores_biometricos (tenant_id);

COMMENT ON TABLE lectores_biometricos IS
  'Lectores de huella del gym. El aparato solo captura: las plantillas viven acá, '
  'cifradas. Cada lector tiene un token (guardado hasheado) con el que su agente '
  'local se identifica.';

ALTER TABLE lectores_biometricos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lectores_admin_all ON lectores_biometricos;
CREATE POLICY lectores_admin_all ON lectores_biometricos
  FOR ALL TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- Recepción los ve (para saber si el lector está vivo), pero no los toca.
DROP POLICY IF EXISTS lectores_recepcion_read ON lectores_biometricos;
CREATE POLICY lectores_recepcion_read ON lectores_biometricos
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());


-- ── 2) LAS HUELLAS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credenciales_biometricas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,

  -- Se enrolan hasta DOS dedos: si el socio se corta o se venda el principal,
  -- sigue entrando sin pasar por el mostrador.
  dedo text NOT NULL CHECK (dedo IN (
    'der_pulgar','der_indice','der_medio','der_anular','der_menique',
    'izq_pulgar','izq_indice','izq_medio','izq_anular','izq_menique'
  )),

  -- LA HUELLA. Cifrada con AES-256-GCM en Netlify; la llave NO está en la base.
  -- Una plantilla no es una foto del dedo: es un mapa de puntos del que no se
  -- reconstruye la huella. Aun así, cifrada.
  plantilla bytea NOT NULL,

  -- Qué formato es ese blob una vez descifrado. Los formatos estándar
  -- (iso19794-2, ansi378) los entiende cualquier lector: son la garantía de que
  -- el gym puede cambiar de marca sin re-enrolar a nadie. `propietario` es el
  -- formato interno de un fabricante: funciona, pero solo con esa marca.
  formato text NOT NULL DEFAULT 'iso19794-2'
    CHECK (formato IN ('iso19794-2', 'ansi378', 'propietario')),

  -- 0-100. Una captura mala genera falsos rechazos: si baja de 60, la UI le pide
  -- a recepción que la repita en vez de dejar al socio con una huella que falla.
  calidad smallint CHECK (calidad IS NULL OR (calidad BETWEEN 0 AND 100)),

  -- Con qué se tomó (para soporte: "las de este lector fallan").
  capturada_con text,

  -- Sin consentimiento no hay enrolamiento. Dato sensible (LFPDPPP).
  consentimiento_at timestamptz NOT NULL,
  enrolado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- Revocar BORRA la plantilla (abajo, en revocar_huella_socio) y deja la fila
  -- como constancia de que existió y de quién la dio de baja. Guardar el rastro
  -- sin guardar el dato.
  revocada_at timestamptz,
  revocada_por uuid REFERENCES usuarios(id) ON DELETE SET NULL
);

-- Un dedo, una vez.
CREATE UNIQUE INDEX IF NOT EXISTS credbio_socio_dedo_unico
  ON credenciales_biometricas (tenant_id, usuario_id, dedo)
  WHERE revocada_at IS NULL;

CREATE INDEX IF NOT EXISTS credbio_tenant_idx
  ON credenciales_biometricas (tenant_id) WHERE revocada_at IS NULL;

COMMENT ON TABLE credenciales_biometricas IS
  'Las huellas de los socios, cifradas. La llave vive en Netlify, no en la base: '
  'un volcado de esta tabla no le sirve a nadie. La columna `plantilla` está '
  'revocada para authenticated (ni el admin del gym la puede leer por la API).';

COMMENT ON COLUMN credenciales_biometricas.plantilla IS
  'Plantilla biométrica CIFRADA (AES-256-GCM, llave en Netlify). Nunca se expone '
  'al navegador. Solo el servidor la lee, y solo para mandársela al agente del '
  'lector que la va a comparar.';

ALTER TABLE credenciales_biometricas ENABLE ROW LEVEL SECURITY;

-- Recepción sabe QUIÉN tiene huella (para no volver a pedírsela), no CUÁL es.
DROP POLICY IF EXISTS credbio_staff_read ON credenciales_biometricas;
CREATE POLICY credbio_staff_read ON credenciales_biometricas
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- El socio ve la suya (para saber que la tiene y poder revocarla).
DROP POLICY IF EXISTS credbio_socio_read ON credenciales_biometricas;
CREATE POLICY credbio_socio_read ON credenciales_biometricas
  FOR SELECT TO authenticated
  USING (usuario_id = get_my_user_id());

-- Escribir es solo por RPC. No hay policy de INSERT/UPDATE/DELETE: nadie escribe
-- una huella "a mano" desde el navegador.

-- ESTO ES LO QUE IMPORTA: la plantilla no sale por la API, ni para el admin.
--
-- OJO con la trampa de Postgres: `REVOKE SELECT (plantilla)` NO sirve si el rol
-- tiene SELECT sobre la TABLA — el permiso de tabla cubre todas las columnas y el
-- revoke por columna no lo anula (lo aprendí por las malas: el self-test lo cazó).
-- La única forma es sacar el permiso de tabla y volver a darlo columna por
-- columna, salteando `plantilla`.
--
-- Consecuencia práctica: el frontend tiene que pedir las columnas por nombre.
-- Un `select=*` contra esta tabla da "permission denied", y está bien que así sea.
REVOKE SELECT ON credenciales_biometricas FROM authenticated;
REVOKE SELECT ON credenciales_biometricas FROM anon;

GRANT SELECT (
  id, tenant_id, usuario_id, dedo, formato, calidad, capturada_con,
  consentimiento_at, enrolado_por, created_at, revocada_at, revocada_por
) ON credenciales_biometricas TO authenticated;


-- ── 3) La cita para tomar la huella ─────────────────────────────────────────
-- El navegador no puede hablar con el USB, así que recepción y el agente local se
-- coordinan por acá: recepción "abre una cita" desde la ficha del socio, el
-- agente la ve, pide el dedo, y la cierra mandando la plantilla.
CREATE TABLE IF NOT EXISTS enrolamientos_huella (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  dedo text NOT NULL,

  -- El consentimiento se recoge ACÁ, en el mostrador, delante del socio. Si la
  -- cita vence sin usarse, no queda ningún dato biométrico: no hubo captura.
  consentimiento_at timestamptz NOT NULL,
  solicitado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,

  -- Una cita abierta es un permiso para escribir una huella. Se vence sola.
  expira_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  completado_at timestamptz,
  cancelado_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrol_pendientes_idx
  ON enrolamientos_huella (tenant_id, expira_at)
  WHERE completado_at IS NULL AND cancelado_at IS NULL;

COMMENT ON TABLE enrolamientos_huella IS
  'La "cita" para tomar una huella. Recepción la abre desde la ficha del socio; el '
  'agente del lector la levanta, pide el dedo y la cierra. Se vence a los 5 min: '
  'una cita abierta es permiso para escribir una huella, y no puede quedar viva.';

ALTER TABLE enrolamientos_huella ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS enrol_staff_read ON enrolamientos_huella;
CREATE POLICY enrol_staff_read ON enrolamientos_huella
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());


-- ── 4) Alta de un lector: devuelve el token UNA sola vez ────────────────────
CREATE OR REPLACE FUNCTION registrar_lector(
  p_nombre text,
  p_sucursal_id uuid DEFAULT NULL,
  p_marca text DEFAULT NULL,
  p_modelo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_token text;
  v_id uuid;
BEGIN
  IF v_tenant IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo el admin puede dar de alta un lector';
  END IF;

  IF p_nombre IS NULL OR length(trim(p_nombre)) = 0 THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO: Ponele un nombre al lector (ej: "Entrada principal")';
  END IF;

  IF p_sucursal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'SUCURSAL_NO_EXISTE: Esa sede no es de este gimnasio';
  END IF;

  -- El token se muestra UNA vez y no se puede volver a ver: guardamos el hash.
  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  INSERT INTO lectores_biometricos (
    tenant_id, sucursal_id, nombre, marca, modelo, token_hash
  ) VALUES (
    v_tenant, p_sucursal_id, trim(p_nombre),
    NULLIF(trim(p_marca), ''), NULLIF(trim(p_modelo), ''),
    _hash_token_lector(v_token)
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true,
    'lector_id', v_id,
    -- La ÚNICA vez que este token existe en texto plano. Se pega en el agente.
    'token', v_token
  );
END;
$$;

REVOKE ALL ON FUNCTION registrar_lector(text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION registrar_lector(text, uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION registrar_lector(text, uuid, text, text) TO authenticated;


-- ── 5) Recepción abre la cita ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iniciar_enrolamiento_huella(
  p_usuario_id uuid,
  p_dedo text,
  p_consentimiento boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_socio usuarios;
  v_id uuid;
  v_activas integer;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden registrar una huella';
  END IF;

  -- La huella es DATO SENSIBLE. Sin consentimiento del socio, no se toma. Esto no
  -- es burocracia: es la diferencia entre un registro legal y uno que no.
  IF NOT COALESCE(p_consentimiento, false) THEN
    RAISE EXCEPTION 'CONSENTIMIENTO_REQUERIDO: El socio tiene que aceptar el uso de su huella antes de registrarla';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL OR v_socio.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: Ese socio no es de este gimnasio';
  END IF;

  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: La huella se registra para socios';
  END IF;

  IF p_dedo IS NULL OR p_dedo NOT IN (
    'der_pulgar','der_indice','der_medio','der_anular','der_menique',
    'izq_pulgar','izq_indice','izq_medio','izq_anular','izq_menique'
  ) THEN
    RAISE EXCEPTION 'DEDO_INVALIDO: Elegí qué dedo se va a registrar';
  END IF;

  IF EXISTS (
    SELECT 1 FROM credenciales_biometricas
    WHERE tenant_id = v_tenant AND usuario_id = p_usuario_id
      AND dedo = p_dedo AND revocada_at IS NULL
  ) THEN
    RAISE EXCEPTION 'DEDO_YA_REGISTRADO: Ese dedo ya está registrado. Revocalo antes de tomarlo de nuevo';
  END IF;

  -- Dos dedos alcanzan (uno de respaldo). Más solo agranda el trabajo de comparar
  -- de cada entrada, sin que el socio gane nada.
  SELECT count(*) INTO v_activas
  FROM credenciales_biometricas
  WHERE tenant_id = v_tenant AND usuario_id = p_usuario_id AND revocada_at IS NULL;

  IF v_activas >= 2 THEN
    RAISE EXCEPTION 'LIMITE_DEDOS: El socio ya tiene 2 dedos registrados. Revocá uno para tomar otro';
  END IF;

  -- Una cita a la vez por socio: si recepción aprieta dos veces, no quedan dos
  -- permisos abiertos para escribirle una huella.
  UPDATE enrolamientos_huella
  SET cancelado_at = now()
  WHERE tenant_id = v_tenant AND usuario_id = p_usuario_id
    AND completado_at IS NULL AND cancelado_at IS NULL;

  INSERT INTO enrolamientos_huella (
    tenant_id, usuario_id, dedo, consentimiento_at, solicitado_por
  ) VALUES (
    v_tenant, p_usuario_id, p_dedo, now(), v_actor
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true,
    'enrolamiento_id', v_id,
    'expira_en_seg', 300
  );
END;
$$;

REVOKE ALL ON FUNCTION iniciar_enrolamiento_huella(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION iniciar_enrolamiento_huella(uuid, text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION iniciar_enrolamiento_huella(uuid, text, boolean) TO authenticated;


-- ── 6) El agente pregunta si hay alguien esperando para poner el dedo ───────
CREATE OR REPLACE FUNCTION enrolamiento_pendiente(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lector lectores_biometricos;
  v_enrol enrolamientos_huella;
  v_socio usuarios;
BEGIN
  SELECT * INTO v_lector FROM lectores_biometricos
  WHERE token_hash = _hash_token_lector(p_token);

  IF v_lector.id IS NULL THEN
    RAISE EXCEPTION 'LECTOR_DESCONOCIDO: Ese lector no está dado de alta';
  END IF;
  IF NOT v_lector.activo THEN
    RAISE EXCEPTION 'LECTOR_INACTIVO: Ese lector está desactivado';
  END IF;

  UPDATE lectores_biometricos SET ultimo_visto_at = now() WHERE id = v_lector.id;

  SELECT * INTO v_enrol
  FROM enrolamientos_huella
  WHERE tenant_id = v_lector.tenant_id
    AND completado_at IS NULL
    AND cancelado_at IS NULL
    AND expira_at > now()
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_enrol.id IS NULL THEN
    RETURN jsonb_build_object('pendiente', false);
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = v_enrol.usuario_id;

  RETURN jsonb_build_object(
    'pendiente', true,
    'enrolamiento_id', v_enrol.id,
    'dedo', v_enrol.dedo,
    -- El nombre, para que el aparato muestre "Apoyá el índice, Ana" y no un uuid.
    'socio', COALESCE(v_socio.nombre, v_socio.email)
  );
END;
$$;

REVOKE ALL ON FUNCTION enrolamiento_pendiente(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION enrolamiento_pendiente(text) FROM anon;
REVOKE ALL ON FUNCTION enrolamiento_pendiente(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION enrolamiento_pendiente(text) TO service_role;


-- ── 7) El agente cierra la cita mandando la huella ──────────────────────────
-- `p_plantilla_cifrada` llega ya cifrada desde Netlify. Postgres nunca ve la
-- huella en claro: si alguien se roba un backup de la base, se lleva ruido.
-- `p_plantilla_cifrada` viaja en base64 (texto): PostgREST manda JSON, y meter un
-- bytea crudo ahí es pedirle problemas.
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

  -- La bitácora guarda QUE se tomó la huella y quién la tomó. No la huella.
  PERFORM _audrec_log(
    'socio.huella_enrolar', 'socio', v_enrol.usuario_id, v_enrol.usuario_id, v_socio.nombre,
    'Registró la huella del socio (con su consentimiento).',
    jsonb_build_object('dedo', v_enrol.dedo, 'lector', v_lector.nombre, 'calidad', p_calidad)
  );

  RETURN jsonb_build_object('success', true, 'credencial_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION completar_enrolamiento_huella(text, uuid, text, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION completar_enrolamiento_huella(text, uuid, text, text, smallint) FROM anon;
REVOKE ALL ON FUNCTION completar_enrolamiento_huella(text, uuid, text, text, smallint) FROM authenticated;
GRANT EXECUTE ON FUNCTION completar_enrolamiento_huella(text, uuid, text, text, smallint) TO service_role;


-- ── 8) El agente se baja las huellas del gym para poder comparar ────────────
-- Devuelve las plantillas CIFRADAS. Netlify las descifra y se las pasa al agente
-- por HTTPS. La llave nunca sale de Netlify.
CREATE OR REPLACE FUNCTION sincronizar_plantillas(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lector lectores_biometricos;
  v_huellas jsonb;
BEGIN
  SELECT * INTO v_lector FROM lectores_biometricos
  WHERE token_hash = _hash_token_lector(p_token);

  IF v_lector.id IS NULL THEN
    RAISE EXCEPTION 'LECTOR_DESCONOCIDO: Ese lector no está dado de alta';
  END IF;
  IF NOT v_lector.activo THEN
    RAISE EXCEPTION 'LECTOR_INACTIVO: Ese lector está desactivado';
  END IF;

  UPDATE lectores_biometricos SET ultimo_visto_at = now() WHERE id = v_lector.id;

  -- Solo socios que hoy pueden entrar. Un ex-socio no tiene por qué seguir
  -- viviendo en la memoria del lector.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'usuario_id', c.usuario_id,
           'dedo', c.dedo,
           'formato', c.formato,
           'plantilla', encode(c.plantilla, 'base64')
         )), '[]'::jsonb)
  INTO v_huellas
  FROM credenciales_biometricas c
  JOIN usuarios u ON u.id = c.usuario_id
  WHERE c.tenant_id = v_lector.tenant_id
    AND c.revocada_at IS NULL
    AND u.status = 'activo';

  RETURN jsonb_build_object(
    'success', true,
    'lector', v_lector.nombre,
    'huellas', v_huellas
  );
END;
$$;

REVOKE ALL ON FUNCTION sincronizar_plantillas(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sincronizar_plantillas(text) FROM anon;
REVOKE ALL ON FUNCTION sincronizar_plantillas(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION sincronizar_plantillas(text) TO service_role;


-- ── 9) Revocar: la huella se BORRA, el rastro queda ─────────────────────────
CREATE OR REPLACE FUNCTION revocar_huella_socio(
  p_usuario_id uuid DEFAULT NULL,
  p_dedo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_objetivo uuid := COALESCE(p_usuario_id, get_my_user_id());
  v_socio usuarios;
  v_borradas integer;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  -- O es tu propia huella, o sos staff. Es tu dedo: podés borrarlo vos.
  IF v_objetivo <> v_actor AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo podés revocar tu propia huella';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = v_objetivo;
  IF v_socio.id IS NULL OR v_socio.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: Ese socio no es de este gimnasio';
  END IF;

  -- Revocar no es esconder: la plantilla se sobreescribe con vacío. Queda la
  -- fila (quién la tenía, quién la borró, cuándo), no el dato biométrico.
  UPDATE credenciales_biometricas
  SET revocada_at = now(),
      revocada_por = v_actor,
      plantilla = '\x'::bytea
  WHERE tenant_id = v_tenant
    AND usuario_id = v_objetivo
    AND revocada_at IS NULL
    AND (p_dedo IS NULL OR dedo = p_dedo);

  GET DIAGNOSTICS v_borradas = ROW_COUNT;

  IF v_borradas = 0 THEN
    RAISE EXCEPTION 'NO_ENROLADO: El socio no tiene una huella registrada';
  END IF;

  -- Solo dejamos bitácora cuando lo hace el STAFF: si el socio revoca su propia
  -- huella desde su app, no es una acción de mostrador.
  IF is_recepcionista() AND v_objetivo <> v_actor THEN
    PERFORM _audrec_log(
      'socio.huella_revocar', 'socio', v_objetivo, v_objetivo, v_socio.nombre,
      'Dio de baja la huella del socio.',
      jsonb_build_object('dedos', v_borradas)
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'dedos_revocados', v_borradas);
END;
$$;

-- La firma vieja (solo usuario_id) desaparece para que nadie llame a la anterior.
DROP FUNCTION IF EXISTS revocar_huella_socio(uuid);

REVOKE ALL ON FUNCTION revocar_huella_socio(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION revocar_huella_socio(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION revocar_huella_socio(uuid, text) TO authenticated;


-- ── 10) EL CHECK-IN POR HUELLA ──────────────────────────────────────────────
-- El agente ya comparó y sabe QUIÉN es. Acá contestamos la pregunta que falta:
-- ¿a qué clase está entrando? Mismas reglas que el QR.
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

  PERFORM _audrec_log(
    'checkin.huella', 'reserva', v_reserva.id, v_socio.id, v_socio.nombre,
    format('Entró con huella por el lector "%s".', v_lector.nombre),
    jsonb_build_object('lector_id', v_lector.id, 'lector', v_lector.nombre)
  );

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

-- La firma vieja (device_user_id) desaparece: ya no existe ese concepto.
DROP FUNCTION IF EXISTS check_in_por_huella(text, text, timestamptz);

-- SOLO el servidor. Un navegador NUNCA llama esto: si pudiera, cualquiera con el
-- token del lector podría marcar entradas desde su casa.
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION check_in_por_huella(text, uuid, timestamptz) TO service_role;


-- ── 11) La bitácora tiene que admitir las acciones nuevas ───────────────────
-- (Si me olvido, el test de contrato de más abajo hace fallar la migración. Que
--  es exactamente para lo que lo pusimos.)
ALTER TABLE auditoria_recepcion DROP CONSTRAINT IF EXISTS auditoria_recepcion_accion_check;
ALTER TABLE auditoria_recepcion ADD CONSTRAINT auditoria_recepcion_accion_check
  CHECK (accion IN (
    'membresia.alta','membresia.renovar','membresia.cambiar_plan','membresia.recargar_creditos',
    'membresia.congelar','membresia.reactivar','membresia.cancelar',
    'reserva.crear','reserva.cancelar','reserva.lista_espera_anotar','reserva.lista_espera_promover',
    'socio.crear','socio.editar_contacto','socio.reset_password','socio.bloquear','socio.desbloquear','socio.nota','socio.aviso',
    'socio.huella_enrolar','socio.huella_revocar',
    'clase.crear','clase.cancelar','clase.editar','clase.reasignar_coach','clase.marcar_asistencia','clase.marcar_no_show',
    'pago.reenviar_link','pago.activar','pago.reembolso',
    'checkin.manual','checkin.qr','checkin.corregir','checkin.huella'
  ));


-- ============================================================================
-- TEST DE CONTRATO: ninguna función escribe una acción que la bitácora rechace.
-- ============================================================================
DO $$
DECLARE
  v_check text;
  v_accion text;
  v_faltan text[] := ARRAY[]::text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_check
  FROM pg_constraint WHERE conname = 'auditoria_recepcion_accion_check';

  FOR v_accion IN
    SELECT DISTINCT m[1]
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         LATERAL regexp_matches(p.prosrc, '_audrec_log\(\s*''([a-z_]+\.[a-z_]+)''', 'g') AS m
    WHERE n.nspname = 'public'
  LOOP
    IF position('''' || v_accion || '''' IN v_check) = 0 THEN
      v_faltan := array_append(v_faltan, v_accion);
    END IF;
  END LOOP;

  IF cardinality(v_faltan) > 0 THEN
    RAISE EXCEPTION 'ACCION_NO_PERMITIDA: %', array_to_string(v_faltan, ', ');
  END IF;
END;
$$;


-- ============================================================================
-- SELF-TEST — con biometría no alcanza con "compila".
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_admin uuid;
  v_socio uuid;
  v_auth uuid := gen_random_uuid();
  v_sucursal uuid;
  v_sala uuid;
  v_clase uuid;
  v_reserva uuid;
  v_lector jsonb;
  v_token text;
  v_enrol jsonb;
  v_pend jsonb;
  v_res jsonb;
  v_err text;
  v_slug text := 'zz-test-huella-' || substr(md5(random()::text), 1, 6);
  v_ahora timestamptz := now();
  -- Hace de plantilla cifrada: para la base es un blob opaco, que es el punto.
  v_blob text := encode(extensions.gen_random_bytes(256), 'base64');
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test huella', 'gym_libre', 'activo')
  RETURNING id INTO v_tenant;

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, raw_user_meta_data,
    encrypted_password, email_confirmed_at, created_at, updated_at
  ) VALUES (
    v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_slug || '-admin@sala.dev',
    jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
    '', now(), now(), now()
  );
  UPDATE usuarios SET rol = 'admin', status = 'activo'
  WHERE auth_id = v_auth RETURNING id INTO v_admin;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-socio@sala.dev', 'Socio Huella', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  -- Toda sala tiene sede: recursos.sucursal_id es NOT NULL desde el hardening.
  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden)
  VALUES (v_tenant, 'Sede test', 'America/Mexico_City', true, 0)
  RETURNING id INTO v_sucursal;

  INSERT INTO recursos (tenant_id, sucursal_id, slug, nombre, tipo, cupos, cupo_max_default, activo)
  VALUES (v_tenant, v_sucursal, 'sala-1', 'Sala 1', 'sala_grupal', 10, 10, true)
  RETURNING id INTO v_sala;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth::text)::text, true);

  -- 1) Alta del lector: el token se ve UNA vez.
  v_lector := registrar_lector('Entrada principal', v_sucursal, 'Marca', 'Modelo');
  v_token := v_lector->>'token';
  IF v_token IS NULL OR length(v_token) < 20 THEN
    RAISE EXCEPTION 'FALLA: el alta del lector no devolvió token';
  END IF;

  -- 2) El token NO se guarda en claro: en la tabla solo hay hash.
  IF EXISTS (SELECT 1 FROM lectores_biometricos WHERE token_hash = v_token) THEN
    RAISE EXCEPTION 'FALLA: el token se guardó en texto plano';
  END IF;

  -- 3) SIN CONSENTIMIENTO NO SE ABRE LA TOMA. La huella es dato sensible.
  BEGIN
    PERFORM iniciar_enrolamiento_huella(v_socio, 'der_indice', false);
    RAISE EXCEPTION 'FALLA: abrió una toma de huella sin consentimiento del socio';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'CONSENTIMIENTO_REQUERIDO%' THEN RAISE; END IF;
  END;

  -- 4) Recepción abre la toma; el agente la ve.
  v_enrol := iniciar_enrolamiento_huella(v_socio, 'der_indice', true);
  v_pend := enrolamiento_pendiente(v_token);
  IF NOT (v_pend->>'pendiente')::boolean
     OR (v_pend->>'enrolamiento_id') <> (v_enrol->>'enrolamiento_id') THEN
    RAISE EXCEPTION 'FALLA: el agente no vio la toma de huella abierta';
  END IF;

  -- 5) Una captura borrosa se rechaza: mejor repetirla que condenar al socio a
  --    pelearse con la puerta todos los días.
  BEGIN
    PERFORM completar_enrolamiento_huella(
      v_token, (v_enrol->>'enrolamiento_id')::uuid, v_blob, 'iso19794-2', 30::smallint);
    RAISE EXCEPTION 'FALLA: aceptó una huella de mala calidad';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'CALIDAD_BAJA%' THEN RAISE; END IF;
  END;

  PERFORM completar_enrolamiento_huella(
    v_token, (v_enrol->>'enrolamiento_id')::uuid, v_blob, 'iso19794-2', 88::smallint);

  -- 6) La toma es de UN solo uso: no queda un permiso abierto para escribir otra.
  BEGIN
    PERFORM completar_enrolamiento_huella(
      v_token, (v_enrol->>'enrolamiento_id')::uuid, v_blob, 'iso19794-2', 88::smallint);
    RAISE EXCEPTION 'FALLA: la misma toma de huella se pudo usar dos veces';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'ENROLAMIENTO_VENCIDO%' THEN RAISE; END IF;
  END;

  -- 7) La huella quedó guardada, y el agente se la puede bajar para comparar.
  v_res := sincronizar_plantillas(v_token);
  IF jsonb_array_length(v_res->'huellas') <> 1 THEN
    RAISE EXCEPTION 'FALLA: el agente no pudo bajarse la huella del socio';
  END IF;
  IF (v_res->'huellas'->0->>'plantilla') IS NULL THEN
    RAISE EXCEPTION 'FALLA: la plantilla llegó vacía';
  END IF;

  -- 8) Sin reserva no hay entrada: la huella no es una llave maestra.
  BEGIN
    PERFORM check_in_por_huella(v_token, v_socio, v_ahora);
    RAISE EXCEPTION 'FALLA: dejó entrar a alguien que no tenía reserva';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'SIN_RESERVA%' THEN RAISE; END IF;
  END;

  -- 9) Con una reserva en curso, entra.
  INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos, cupo_max, status, nombre)
  VALUES (v_tenant, v_sucursal, v_sala, (v_ahora AT TIME ZONE 'UTC')::date,
          (v_ahora AT TIME ZONE 'UTC')::time, 60, 10, 'programada', 'Clase test')
  RETURNING id INTO v_clase;

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id, clase_id,
    slot_inicio, slot_fin, duracion_min, invitados_count, status, folio
  ) VALUES (
    v_tenant, v_sala, v_socio, v_clase,
    v_ahora, v_ahora + interval '60 minutes', 60, 0, 'confirmada', 'SAL-TEST-1'
  )
  RETURNING id INTO v_reserva;

  v_res := check_in_por_huella(v_token, v_socio, v_ahora);
  IF NOT (v_res->>'success')::boolean THEN
    RAISE EXCEPTION 'FALLA: el check-in por huella no funcionó';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM reservas
    WHERE id = v_reserva AND status = 'completada' AND check_in_method = 'huella'
  ) THEN
    RAISE EXCEPTION 'FALLA: la reserva no quedó marcada como entrada por huella';
  END IF;

  -- 10) Un token inventado no abre nada, ni siquiera para bajarse las huellas.
  BEGIN
    PERFORM sincronizar_plantillas('token-falso');
    RAISE EXCEPTION 'FALLA: un lector desconocido pudo bajarse las huellas del gym';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'LECTOR_DESCONOCIDO%' THEN RAISE; END IF;
  END;

  -- 11) Revocada la huella: se BORRA la plantilla y el lector deja de verla.
  PERFORM revocar_huella_socio(v_socio, NULL);

  IF EXISTS (
    SELECT 1 FROM credenciales_biometricas
    WHERE usuario_id = v_socio AND octet_length(plantilla) > 0
  ) THEN
    RAISE EXCEPTION 'FALLA: revocar dejó la huella guardada';
  END IF;

  v_res := sincronizar_plantillas(v_token);
  IF jsonb_array_length(v_res->'huellas') <> 0 THEN
    RAISE EXCEPTION 'FALLA: una huella revocada se le siguió mandando al lector';
  END IF;

  BEGIN
    PERFORM check_in_por_huella(v_token, v_socio, v_ahora);
    RAISE EXCEPTION 'FALLA: una huella revocada siguió abriendo la puerta';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'HUELLA_NO_RECONOCIDA%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
END;
$$;

SELECT 'el token del lector se guarda hasheado, nunca en claro' AS prueba,
       'sin texto plano' AS espera, 'OK' AS resultado
UNION ALL
SELECT 'sin consentimiento del socio no se toma la huella', 'rechazado', 'OK'
UNION ALL
SELECT 'una huella borrosa se rechaza en vez de condenar al socio', 'rechazado', 'OK'
UNION ALL
SELECT 'la toma de huella es de un solo uso y se vence sola', 'rechazado', 'OK'
UNION ALL
SELECT 'el agente se baja las huellas del gym para comparar', '1 huella', 'OK'
UNION ALL
SELECT 'sin reserva no se entra: la huella no es llave maestra', 'rechazado', 'OK'
UNION ALL
SELECT 'con reserva en curso, el check-in queda como método huella', 'completada', 'OK'
UNION ALL
SELECT 'un lector desconocido no puede bajarse las huellas del gym', 'rechazado', 'OK'
UNION ALL
SELECT 'revocar BORRA la plantilla, no la esconde', 'plantilla vacía', 'OK'
UNION ALL
SELECT 'el navegador no puede llamar al check-in por huella',
       'solo service_role',
       CASE WHEN has_function_privilege('authenticated', 'check_in_por_huella(text, uuid, timestamptz)', 'EXECUTE')
            THEN 'FALLA' ELSE 'OK' END
UNION ALL
SELECT 'el navegador no puede bajarse las huellas del gym',
       'solo service_role',
       CASE WHEN has_function_privilege('authenticated', 'sincronizar_plantillas(text)', 'EXECUTE')
            THEN 'FALLA' ELSE 'OK' END
UNION ALL
SELECT 'ni el admin del gym puede leer una plantilla por la API',
       'columna revocada',
       CASE WHEN has_column_privilege('authenticated', 'credenciales_biometricas', 'plantilla', 'SELECT')
            THEN 'FALLA' ELSE 'OK' END
UNION ALL
-- ...pero recepción SÍ tiene que poder ver quién tiene huella, o no puede trabajar.
SELECT 'recepción sí puede ver qué dedo tiene registrado el socio',
       'columna visible',
       CASE WHEN has_column_privilege('authenticated', 'credenciales_biometricas', 'dedo', 'SELECT')
            THEN 'OK' ELSE 'FALLA' END;
