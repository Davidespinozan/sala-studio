# EKKO Studio — Arquitectura del Kernel SaaS

> Este documento captura las decisiones arquitectónicas del producto
> replicable que se está construyendo a partir de EKKO Studio.
> El kernel es lo que se va a extraer cuando vendamos a clientes
> más allá de Cravia.

## Filosofía

EKKO es un **SaaS multi-tenant** desde el día 1. Cravia es el
primer cliente, no el único. Cada decisión técnica considera:

1. ¿Esto va a ser igual para todos los tenants? → al kernel
2. ¿Esto va a variar por tenant? → al config jsonb
3. ¿Esto va a variar por vertical (creator studio vs yoga)? →
   pendiente Sprint E (vocabulario configurable)

## Capas del producto

### Capa 1: Kernel (universal, no toca al replicar)

- Auth con Supabase
- Layouts: PublicLayout, MemberLayout, AdminLayout
- RPC `reservar_recurso_atomic` con guards de status, anticipación,
  horario, tier, max_invitados, continuas, overlap
- Sistema de tiers con beneficios y reglas (max_invitados)
- Pagos: Stripe (Sprint pendiente)
- CMS de landing: hero, footer, cta_final editables
- Bucket público de fotos por tenant (`estudios/`)
- TenantProvider con resolución por slug (subdomain o fallback)

### Capa 2: Dominio (configurable por instancia)

- `tenants.config.landing.*` — textos de landing por tenant
- `tenants.config.contacto.whatsapp_e164` — contacto por tenant
- `tenants.config.reserva.*` — reglas de reservación por tenant
- `tenants.config.penalizaciones.*` — penalizaciones por tenant
- `tiers` table — nombres, precios, beneficios, reglas por tenant
- `recursos` table — estudios/salas con foto, capacidad, equipo

### Capa 3: Branding (data-driven, pendiente Sprint D)

- `tenants.branding.logo_url` — logo principal
- `tenants.branding.logo_url_dark` / `logo_url_light` — variantes
- `tenants.branding.og_image_url` — Open Graph
- `tenants.branding.favicon_url` — favicon dinámico
- `tenants.branding.color_*` — colores dinámicos (pendiente
  Sprint D, requiere refactor de design tokens)

## Patrones de código

### Parseo defensivo de jsonb

Todo consumo de `tenants.config.*` debe pasar por un hook con
defaults explícitos. Ejemplos:

- `useLandingConfig` → bloque landing + contacto
- `parseBeneficios` (en Landing.tsx + Tiers.tsx) → arrays string

Los defaults del hook son **strings vacíos** (no textos EKKO
específicos). El kernel no debe asumir nombre de cliente. Los textos
reales vienen de la migración SQL del tenant inicial.

### Schema-first con migraciones

Cada cambio de estructura va en una migración SQL. Los textos
default de un tenant vienen en la migración, NO en el hook.
El hook tiene defaults vacíos para que un tenant nuevo no rompa.

### Componentes desacoplados de identidad

Componentes como Footer NO deben hardcodear "EKKO" ni "Cravia".
Todo viene de `useTenant()` (nombre, slug) o `useLandingConfig()`.

## Pendientes para producto replicable

### Sprint C2 (próximo)

- FAQ editable (hoy 6 items hardcoded inline en Landing.tsx)
- Sección "Cómo funciona" editable (3 pasos hardcoded)
- Títulos de sección Estudios y Membresías editables
- Refactor AutoForm para mejor UX en bloques profundos (toggle
  para activar/limpiar campos nullable)

### Sprint D (alta prioridad)

- Logo upload + favicon dinámico
- Tabla `anuncios` para banners temporales por tenant
- Branding tokens dinámicos (refactor de design system)

### Sprint E (cuando aparezca cliente B real)

- Vocabulario configurable: `tenants.config.ui.etiqueta_recurso`
  permitiría rename "Estudio" → "Sala" / "Cabina" / "Espacio"
- Auditoría: ~30 lugares hardcoded en codebase
- Crítico para vender a yoga/pilates/podcast booths

### Sprint F (multi-página)

- Si se necesitan rutas separadas (/terminos, /privacidad),
  considerar tabla `tenant_pages` con slug + content jsonb
- Versionado / drafts / preview

## Anti-patrones (NO hacer)

1. **NO hardcodear "EKKO", "Cravia", "Culiacán"** en componentes.
   Todo viene del tenant config.

2. **NO hardcodear textos de UI** que vayan a variar por tenant.
   Si es contenido editable, va al jsonb.

3. **NO duplicar el WhatsApp.** Hay UN solo punto de verdad:
   `tenants.config.contacto.whatsapp_e164`. Consumido vía el
   helper `whatsappUrl()` del hook `useLandingConfig`.

4. **NO crear tablas nuevas para contenido editable.** El jsonb
   permite iteración rápida sin migraciones. Solo tablas para
   datos relacionales o transaccionales (anuncios, reservas).

5. **NO mezclar branding con config.** Branding son assets/colores
   visuales. Config son textos/reglas de negocio.

6. **NO leer `tenants.config` directamente** desde componentes —
   pasá por el hook correspondiente con parseo defensivo.

## Patrón Soft-Delete (Sprint C-CRUD)

### Filosofía
Todas las entidades de dominio (recursos, tiers, anuncios futuros)
usan soft delete vía campo `activo: boolean`. **NUNCA** hard delete.

### Razones
1. **Integridad referencial**: reservas históricas mantienen
   referencia al estudio donde ocurrieron, aunque el estudio
   ya no esté activo.
2. **Reversibilidad**: admin puede restaurar errores sin perder
   datos.
3. **Auditoría**: queda registro histórico de qué estuvo activo
   y cuándo.
4. **Stripe**: tier archivado con `stripe_price_id` no se borra;
   queda referencia para reportes pasados.

### Contrato de implementación
Toda entidad soft-deletable debe:
1. Tener columna `activo BOOLEAN NOT NULL DEFAULT true`.
2. Tener índice `(tenant_id, activo)` para performance.
3. Filtrar `WHERE activo = true` en TODAS las queries públicas
   (landing, member, signup).
4. Mostrar archivados solo en admin con toggle explícito.
5. Validar antes de archivar si hay dependencias activas
   (ej: tier con miembros activos via `countActiveMembersInTier`).
6. **NUNCA** copiar referencias externas únicas (Stripe IDs, etc.)
   al duplicar — son globalmente únicas en otro sistema.

### Patrón "Duplicar"
Helper `generateUniqueSlug(base, existingSlugs)` + omitir campos
auto-generados (id, created_at, stripe_*). Prefijo "(copia)" en
nombre para diferenciación visual inmediata.

### Tablas que aplican el patrón
- `recursos` (estudios)
- `tiers` (membresías)
- `anuncios` (futuro Sprint D)

### Tablas que NO aplican (datos transaccionales)
- `reservas` — cancelar es propio dominio (`status='cancelada'`),
  no soft-delete genérico.
- `payment_events` — eventos inmutables, nunca se archivan.
- `usuarios` — el equivalente es `status='suspendido'` o
  `'cancelado'`, no `activo` boolean.

### Helpers reusables
- `src/admin/lib/crudHelpers.ts`
  - `archiveRecord(table, id)`
  - `restoreRecord(table, id)`
  - `generateUniqueSlug(base, existing)`
  - `countActiveMembersInTier({tierId, tierSlug, tenantId})`

### Componente reusable
- `src/admin/components/ConfirmDialog.tsx`
  - Variants: `'danger' | 'warning' | 'info'`
  - `hideConfirm` para modo informativo bloqueante (ej: archivar
    tier con miembros activos)

## Patrón Admin Profesional (Sprint D-Admin)

### Filosofía
El admin de EKKO no es un form-builder genérico. Es producto diseñado
para dueños de negocio no técnicos. Cada pantalla responde a un caso
de uso real, no a un schema de BD.

### Estructura del sidebar
- **OPERACIÓN**: día a día (Dashboard, Miembros, Reservas)
- **CATÁLOGO**: productos vendibles (Estudios, Planes)
- **AJUSTES**: 4 páginas dedicadas (Landing, Contacto, Reglas, Marca)
- **VER COMO…**: previsualización del producto (4 links que abren
  en nueva pestaña)

### Reglas de UX
1. **Labels humanos siempre**: nunca mostrar nombres técnicos al
   admin. `whatsapp_e164` → "Número de WhatsApp".
2. **Helper text en cada campo crítico**: explicación corta + ejemplo
   cuando aplica.
3. **Bloques DEAD no se muestran**: si una config está sembrada en BD
   pero no consumida en producción, NO va en admin. Solo se muestra
   lo que afecta al producto real. La página `/admin/reglas` solo
   expone los 4 campos consumidos por el RPC.
4. **Feedback de cambios**: indicador "Sin cambios" / "Cambios sin
   guardar". Botón "Guardar" explícito. Toast al guardar.
5. **VER COMO**: admin puede previsualizar cualquier vista del producto
   sin perder su sesión. Demo guard sobre `?demo=admin-preview` (TODO
   Sprint Stripe).

## Patrón Soft + Hard Delete con Guards (Sprint D-Admin)

### Vocabulario
- **UI**: "Eliminar" (no "Archivar")
- **BD**: campo `activo: boolean` (soft delete) — sigue siendo soft
  delete internamente
- **Hard delete**: opción "Eliminar permanentemente" desde la papelera
  con typed confirmation ("ELIMINAR")

### Flow
1. **Click "Eliminar" en activo** → soft delete (`activo=false`) →
   confirma con dialog warning → toast "Se moverá a eliminados".
2. **Click "Recuperar" en eliminado** → `activo=true` → toast.
3. **Click "Eliminar permanente" en eliminado** → check FKs vía RPC
   → si OK, typed confirmation ("ELIMINAR") → DELETE FROM table.

### Guards
- **Recursos**: NO permitir hard delete si hay reservas vinculadas
  (cualquier estado).
- **Tiers**: NO permitir hard delete si hay miembros vinculados
  (activos o históricos, doble fuente: `membresias.tier_id` +
  `usuarios.membresia_tier`).
- Hard delete SOLO disponible desde sección "Eliminados".
- Hard delete SOLO con typed confirmation.

### Helpers
- `canHardDeleteRecurso(id)` → `{ canDelete, reason?, count? }`
- `canHardDeleteTier(id)` → idem
- `hardDeleteRecord(table, id)` — IRREVERSIBLE
- RPCs SQL: `count_reservas_recurso`, `count_miembros_tier`

## Hook reusable: useTenantConfigEditor (Sprint D-Admin)

### Propósito
Hook que abstrae el patrón de edición de bloques en `tenants.config`
jsonb. Usado por todas las páginas de AJUSTES (Landing, Contacto,
Reglas) y disponible para sprints futuros (Marca, FAQ, etc).

### API

```typescript
const { config, isLoading, isSaving, saveTopLevel, reload } = useTenantConfigEditor();
```

- `config`: snapshot completo del config (o null mientras carga).
- `isLoading`/`isSaving`: estados de fetch / mutation.
- `saveTopLevel(patch)`: hace `UPDATE tenants SET config = { ...config, ...patch }`.
  El merge es **shallow en top-level** — el caller es responsable de
  preservar sub-keys no modificadas.
- `reload()`: re-fetch desde BD (útil para descartar cambios).

### Merge no destructivo (responsabilidad del caller)

Como `saveTopLevel` solo hace merge shallow, cada página que edita un
sub-objeto anidado (ej. `landing.hero`) tiene que componer el patch
preservando otras keys del bloque:

```typescript
const landing = (config?.landing ?? {}) as Record<string, unknown>;
const patch = {
  landing: {
    ...landing,  // preserva cta_final, footer, etc.
    hero: nuevoHero
  }
};
await saveTopLevel(patch);
```

Este patrón es lo que protege los bloques DEAD sembrados en BD
(`config.ui`, `config.acceso`, etc.): nadie los toca, nadie los
borra, quedan a la espera de un sprint que los consuma o limpie.

### Aplicaciones actuales
- `AjustesLanding.tsx` — `config.landing.hero`, `cta_final`, `footer`
- `AjustesContacto.tsx` — `config.contacto`, `config.landing.footer.redes`
- `AjustesReglas.tsx` — `config.reserva`, `config.penalizaciones`

### Aplicaciones futuras
- `AjustesMarca.tsx` — `tenants.branding.logo_url`, `colors.*`
- Sprint C2 — `config.landing.faq`, `config.landing.como_funciona`

## VER COMO… + Demo Mode (Sprint D-Polish)

### Propósito
Permite al admin previsualizar el producto como lo vería cada tipo de
usuario, sin perder su sesión de admin.

### Vistas disponibles
- 🏠 **Landing**: vista pública (`/?demo=admin-preview`)
- 👤 **Miembro**: app del miembro (`/app?demo=admin-preview`)
- 📋 **Recepción**: panel de check-in (`/recepcion?demo=admin-preview`)

Signup excluido: el admin ya lo ve en flow normal cuando un visitante
hace click en una membresía desde Landing.

### Flow técnico
1. Click VER COMO en sidebar admin → `window.open(url, '_blank')`.
2. Nueva pestaña carga la ruta con `?demo=admin-preview`.
3. `useRoleRedirect` detecta el parámetro y **bypassea** el redirect
   automático a `/admin` que normalmente dispararía con un admin
   logueado.
4. `DemoBanner` se renderiza sticky-top con "Volver al admin →".
5. Click "Volver al admin": `window.close()` con fallback a redirect
   a `/admin/landing` después de 100ms (cubre el caso de pestañas
   abiertas manualmente que el navegador no deja cerrar por script).

### Dónde se monta DemoBanner
- `PublicLayout.tsx` (vista Landing)
- `MemberLayout.tsx` (vista Miembro)
- `ReceptionLayout.tsx` (vista Recepción)

### Seguridad (pendiente)
Hoy el demo mode NO tiene guard estricto: cualquiera con la URL puede
ver las vistas, pero solo si tiene sesión válida del rol correspondiente
(el guard de auth sigue activo). Riesgo bajo. TODO Sprint Stripe:
- Validar admin via JWT custom claim en Edge Function
- Logging server-side de cada uso de demo mode

## Sistema de Toasts (Sprint D-Admin)

`ToastProvider` global en root. Hook `useToast()` expone 4 métodos:
`success`, `error`, `warning`, `info`. Stack vertical en esquina
bottom-right con auto-dismiss + manual close.

**Reemplaza TODOS los `alert()`** del codebase. Cero `alert()` en src/
(verificado por grep).

## Separación Miembros vs Equipo (Sprint Equipo)

### Filosofía
El admin de EKKO separa dos tipos de usuarios:
1. **Miembros**: clientes pagadores. CRUD frecuente, bajo riesgo.
2. **Equipo**: staff con acceso al sistema (admins, recepcionistas).
   CRUD raro, alto riesgo (IAM).

### Por qué separados
- Diferentes casos de uso (gestionar clientes vs gestionar accesos).
- Diferentes acciones primarias ("+ Nuevo miembro" vs "+ Invitar persona").
- Diferentes validaciones (delete cliente vs revocar acceso).
- Mejor escalabilidad: un yoga studio puede tener 200 clientes + 5
  instructores; un restaurante puede tener 0 clientes + 12 empleados.

### URLs
- `/admin/miembros` → SOLO usuarios con `rol='miembro'`.
- `/admin/equipo` → admins + recepcionistas.

### Validaciones de seguridad
1. **No auto-modificación**: admin no puede revocar/cambiar su propio rol.
2. **Último admin protegido**: no se puede revocar al último admin del
   tenant. Mensaje claro de qué hacer ("invita o promueve a alguien
   antes").
3. **Soft-revoke**: `status='revocado'` (no hard delete). Preserva
   auditoría e historial de acciones. La persona no puede loguear pero
   su row queda en BD.

### Patrón "Crear acceso" (Sprint Fix Equipo)
- Admin crea usuario del equipo con email + password directos.
- Edge Function `create-team-member` (deployada en Supabase) usa
  `service_role` para crear el auth user + insertar en `usuarios`
  con `auth_id` real y `status='activo'`.
- Admin recibe modal de confirmación (`CredencialesCreadasModal`)
  con las credenciales formateadas y botón "Copiar".
- Comparte credenciales manualmente (WhatsApp, llamada).
- Si la persona pierde la password: "Olvidé mi contraseña" desde
  `/login` (flow nativo de Supabase Auth).

### Por qué NO email automático (todavía)
- Email automático requiere infra adicional (Resend o similar).
- Templates branded requieren Sprint Marca con logo.
- Realidad operativa de SMBs LATAM: admins prefieren WhatsApp.
- Si en el futuro se necesita email automático, agregar como
  opción adicional sin romper este flow simple.

### Estados del usuario del equipo
- `activo` + `invitado=false`: trabajando normalmente (default
  post Sprint Fix Equipo).
- `revocado`: ya no puede loguear, datos preservados.
- `suspendido`: temporal (futuro, no implementado aún).
- `pendiente_onboarding` + `invitado=true`: **LEGACY** del Sprint
  Equipo original. Ya no se crea con este estado; queda la columna
  en BD por compatibilidad y para reuso futuro (email automático
  opt-in).

### Roles soportados (Sprint Equipo)
- `admin`: acceso total
- `recepcionista`: acceso operativo (check-in, reservas, lectura)

Roles futuros (no implementados):
- `contador`: solo finanzas/reportes
- `marketing`: solo landing + anuncios
- Permisos granulares: opt-in checkboxes en lugar de roles fijos

### Helpers
- `countAdminsActivos(tenantId)` → number — RPC backend
- `canModifyTeamMember({...})` → { canModify, reason? } — front-end gate
- `revokeTeamMember(userId)` → soft-revoke (status='revocado')

## Dashboard relevante (Sprint Final)

### Filosofía
NUNCA agregar métricas que no respondan una pregunta accionable.
Métricas deshabilitadas elegantemente cuando faltan integraciones
(mostrar "—" + CTA "Conecta Stripe", no $0). Comparativos siempre
que haya data; "Primer mes 🎉" como fallback.

### 3 secciones máximo
- **HOY**: operación inmediata (próximas reservas + cancelar)
- **TU MES**: tendencia (3 métricas con flecha ↑/↓ + gráfica 30 días)
- **DINERO**: cuando aplica (deshabilitado hasta Stripe)

### NO agregar
- Top estudios, top tiers, MRR, churn, ocupación absoluta sin contexto,
  cobros pendientes (modelo de contado), alertas genéricas inventadas.

## Cancelación de reservas (Sprint Final)

### Vocabulario
- UI: "Cancelar reserva" (no "Eliminar reserva").
- BD: `status='cancelada_admin'` (distinguible de `cancelada` que es
  acción del miembro).
- Helper: `cancelarReserva({ reservaId, motivo, canceladoPorId, notificarMiembro })`.

### Flow
1. Admin abre modal con info de reserva (no editable).
2. Motivo obligatorio (mínimo 5 chars, se comparte con el miembro).
3. Checkbox "Notificar al miembro" (default: true).
4. Sugerencia WhatsApp pre-formateada con el motivo escrito en
   tiempo real + botón "Copiar mensaje".
5. Typed confirmation "CANCELAR".
6. UPDATE reservas + INSERT notificaciones (in-app inbox).
7. Toast success + refetch.

### Notificaciones in-app
- Tabla `notificaciones` con `usuario_id`, `tipo`, `titulo`, `mensaje`,
  `leida`, `metadata`.
- Banner sticky-top mostaza en `MemberLayout` que renderiza las no
  leídas (hasta 5). Botón ✕ marca como leída individualmente.
- RLS: usuario solo lee/marca las suyas; admin del tenant inserta.
- Email/SMS: pendiente Sprint Resend.

## Branding (Sprint Final · slim)

### Schema
`tenants.branding` jsonb con keys:
- `logo_url_dark` — logo principal (header oscuro, sidebar admin, footer)
- `og_image_url` — imagen Open Graph para redes
- `favicon_url` — favicon dinámico

### Upload
Bucket público `logos` con policies: SELECT anon, INSERT/UPDATE/DELETE
solo admin. Path: `{tenant_slug}/{nombre-asset}-{timestamp}.{ext}`.
Reusa el componente `ImageUploader` existente.

### Consumo
- `Sidebar.tsx` (admin) renderiza `<img logoUrl>` si existe, sino
  fallback a texto `tenant.nombre.split()[0]`.
- `Footer.tsx` (público) mismo patrón.
- OG image y favicon dinámicos via meta tags: **pendiente** hooks
  `useOGTags` y `useFavicon` (Sprint posterior con Marca completa).

## Onboarding de un tenant nuevo

Ver [TENANT_SETUP.md](TENANT_SETUP.md) en este mismo directorio.
