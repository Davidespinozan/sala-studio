-- ============================================================================
-- Reset del branding de sala-demo al sage oficial de SALA.
-- ----------------------------------------------------------------------------
-- Durante una prueba se le puso un accent AMARILLO a sala-demo. Como en
-- marketing/localhost el TenantProvider carga sala-demo y pisa --sala-primary/
-- --sala-accent en :root, ese amarillo se filtraba al preview del onboarding y a
-- la landing del propio tenant. El código de la landing SALA ya no usa amarillo;
-- esto limpia el DATO del tenant demo. Idempotente y seguro (es el demo).
-- ============================================================================

UPDATE tenants
SET branding = COALESCE(branding, '{}'::jsonb)
  || jsonb_build_object(
       'color_primary', '#3D6B52',
       'color_accent', '#3D6B52'
     )
WHERE slug = 'sala-demo';
