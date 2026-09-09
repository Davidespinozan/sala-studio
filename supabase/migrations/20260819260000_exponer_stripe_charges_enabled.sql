-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Exponer tenants.stripe_charges_enabled a la app (booleano público, no secreto)
-- ----------------------------------------------------------------------------
-- BUG: la app decide si un gym cobra online con `tenant.stripe_charges_enabled`
-- (socioPuedePagarEnApp → gymCobraOnline). Pero el GRANT de columnas de `tenants` a
-- anon/authenticated NO incluía esa columna (solo id, slug, nombre, branding, config,
-- dominios, status, fechas). Resultado: el front SIEMPRE la leía como undefined→false,
-- así que NINGÚN gym mostraba el cobro en línea, aunque tuviera Stripe Connect listo
-- (caso The Core Studio: Stripe conectado y aun así la app decía "coordina el pago").
--
-- FIX: conceder SELECT de esa sola columna. Es un booleano ("este gym puede cobrar en
-- línea"), no es dato sensible (lo secreto —stripe_account_id, stripe_subscription_
-- product_id— sigue revocado). El front también la agrega a su SELECT (TenantProvider).
-- ============================================================================

GRANT SELECT (stripe_charges_enabled) ON tenants TO anon, authenticated;

-- Verificación (devuelve tabla): ambas deben ser true.
SELECT has_column_privilege('anon',          'tenants', 'stripe_charges_enabled', 'SELECT') AS anon_puede_leer,
       has_column_privilege('authenticated', 'tenants', 'stripe_charges_enabled', 'SELECT') AS auth_puede_leer;
