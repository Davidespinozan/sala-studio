-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- FIX — la huella no se guardaba: el agente manda formato 'ansi378-2004' pero el
-- CHECK de credenciales_biometricas.formato solo aceptaba 'ansi378'.
-- ────────────────────────────────────────────────────────────────────────────
-- El agente del lector (DPUruNet) exporta ANSI 378-2004 y sube la plantilla con
-- formato='ansi378-2004'. Pero el CHECK original era ('iso19794-2','ansi378',
-- 'propietario') → el INSERT en credenciales_biometricas fallaba por el CHECK, la
-- huella nunca se guardaba, el agente reintentaba en bucle y la pantalla de
-- recepción terminaba diciendo "la toma venció". El lector capturaba perfecto; lo
-- que fallaba era ESTE nombre de formato que no empataba.
--
-- Se agrega 'ansi378-2004' a los permitidos. Solo es la ETIQUETA del blob; los
-- bytes ya eran ANSI 378 y el matching (enrolar y comparar en ANSI) no cambia.
-- Arreglo 100% de base: el agente que ya tiene el gym (v5) queda igual.
-- ════════════════════════════════════════════════════════════════════════════

-- Quitar el CHECK viejo del formato (sea cual sea su nombre autogenerado).
DO $$
DECLARE v_name text;
BEGIN
  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'credenciales_biometricas'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%formato%';
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE credenciales_biometricas DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

ALTER TABLE credenciales_biometricas
  ADD CONSTRAINT credenciales_biometricas_formato_check
  CHECK (formato IN ('iso19794-2', 'ansi378', 'ansi378-2004', 'propietario'));

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA: el CHECK ya acepta 'ansi378-2004' (y sigue rechazando
-- basura). Sin tocar datos reales.
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'formato huella ansi378-2004' AS prueba,
  pg_get_constraintdef(
    (SELECT oid FROM pg_constraint
     WHERE conrelid = 'credenciales_biometricas'::regclass
       AND conname = 'credenciales_biometricas_formato_check')
  ) ILIKE '%ansi378-2004%' AS acepta_ansi378_2004,
  pg_get_constraintdef(
    (SELECT oid FROM pg_constraint
     WHERE conrelid = 'credenciales_biometricas'::regclass
       AND conname = 'credenciales_biometricas_formato_check')
  ) ILIKE '%iso19794-2%' AS conserva_iso;