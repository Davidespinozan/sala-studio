-- ============================================================================
-- USUARIOS (perfiles extendidos de auth.users)
-- ============================================================================
-- 1 fila por cada usuario humano del sistema, con su rol y tenant.
-- Se crea automáticamente vía trigger on_auth_user_created (ver 010).
-- ============================================================================

CREATE TABLE IF NOT EXISTS usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,

  -- Identidad
  email text NOT NULL,
  nombre text,
  telefono text,
  avatar_url text,

  -- Rol dentro del tenant
  rol text NOT NULL DEFAULT 'miembro'
    CHECK (rol IN ('admin', 'recepcionista', 'staff', 'miembro')),

  -- Datos de onboarding (solo para miembros)
  -- Estructura jsonb libre, ej:
  -- { "tipo_contenido": "podcasts", "frecuencia_esperada": 8, "intereses": [...] }
  ob_data jsonb DEFAULT '{}'::jsonb,

  -- Estado del miembro (irrelevante para admin/recepcionista)
  status text NOT NULL DEFAULT 'pendiente_onboarding'
    CHECK (status IN ('pendiente_onboarding', 'pendiente_pago', 'activo',
                      'suspendido', 'cancelado')),

  -- Membresía (se llena cuando hay suscripción Stripe activa; ver tabla membresías)
  membresia_tier text,                          -- 'basica' | 'pro' | null
  membresia_activa_id uuid,                     -- FK a membresias (se agrega en 004)
  trial_ends_at timestamptz,
  commitment_ends_at timestamptz,               -- 6 meses desde primer pago

  -- Penalización por no-show
  no_shows_count integer NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,                  -- si > now() no puede reservar

  -- Stripe customer (1 por miembro)
  stripe_customer_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS usuarios_auth_id_idx ON usuarios (auth_id);
CREATE INDEX IF NOT EXISTS usuarios_tenant_id_idx ON usuarios (tenant_id);
CREATE INDEX IF NOT EXISTS usuarios_email_lower_idx ON usuarios (lower(email));
CREATE INDEX IF NOT EXISTS usuarios_rol_idx ON usuarios (tenant_id, rol);
CREATE INDEX IF NOT EXISTS usuarios_status_idx ON usuarios (tenant_id, status);
CREATE INDEX IF NOT EXISTS usuarios_stripe_customer_idx ON usuarios (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

DROP TRIGGER IF EXISTS usuarios_set_updated_at ON usuarios;
CREATE TRIGGER usuarios_set_updated_at
  BEFORE UPDATE ON usuarios
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
