# Deployment — EKKO Studio

Placeholder. Se completa en Fase 0.5 cuando hagamos el primer deploy.

## Configuración inicial de Supabase Auth

Antes de probar signup/login, asegúrate de que en
https://supabase.com/dashboard/project/cfihcrjbvgjiohedsjos/auth/providers
esté configurado:

1. **Email provider habilitado** (default sí)
2. **Confirm email**: depende de preferencia
   - **OFF** (recomendado para desarrollo): signup → sesión inmediata, ves
     el dashboard sin esperar email
   - **ON** (producción): signup → email de confirmación → click → sesión

Para desarrollo, recomendado dejar OFF mientras se construyen las features.

3. **Site URL**: `http://localhost:5173` (development)
4. **Redirect URLs**: agregar `http://localhost:5173/**`

Cuando deploy a producción, actualizar Site URL y Redirect URLs al
dominio real (`https://ekko.studio` o el que se use).
