-- Extensiones necesarias para el schema EKKO/SALA

CREATE EXTENSION IF NOT EXISTS "pgcrypto";       -- gen_random_uuid
CREATE EXTENSION IF NOT EXISTS "pg_trgm";        -- búsqueda por texto en admin
CREATE EXTENSION IF NOT EXISTS "btree_gist";     -- exclusion constraints para slots
