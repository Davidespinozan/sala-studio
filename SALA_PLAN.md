# SALA Studio — Roadmap

## Sprint timeline (4 semanas - 10 días ya consumidos en EKKO)

### Completado

- **S1**: Bootstrap técnico (cleanup + setup infra)

### Pendiente

- **S2**: Branding SALA (logo, colores, identidad propia)
- **S3**: Vocabulario UI gimnasios (Estudio → Clase, Tier → Plan)
- **S4**: Modelo cupos (clases con N reservas vs 1:1) ⚠️ requiere info socio
- **S5**: Clases recurrentes (Lun 7AM todas las semanas) ⚠️ requiere info socio
- **S6**: Instructores (entidad nueva)
- **S7**: Stripe Connect (cada gym cobra independiente)
- **S8**: Landing comercial pública (sala-studio.com)
- **S9**: Onboarding wizard (signup self-service)
- **S10**: QA + launch primer gym

## Decisiones pendientes (requieren conversación con socio)

- ¿Gimnasios libres o clases con cupo, o ambos?
- ¿Cuántos gyms listos para empezar?
- ¿Modelo de pago entre socios?
- ¿Stripe Connect o cobro centralizado?

## Reuso desde EKKO

40-50% del código se reutiliza:

- Multi-tenancy (tenant_id everywhere)
- Auth + roles (admin/recepcionista/miembro)
- CMS landing
- Branding dinámico (logo, OG, favicon)
- Admin panel structure
- Sistema cancelación + notificación in-app
- Dashboard (saludo, métricas, gráfica SVG)
- Crear acceso para staff
- Edge Functions pattern
