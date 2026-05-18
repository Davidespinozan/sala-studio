# Cómo onboardear un tenant nuevo en EKKO

> Checklist operativo para activar un cliente nuevo. Asume que
> ya hubo venta y firma de contrato.

## Pre-requisitos

- Cliente firmó contrato
- Logo en alta resolución
- Información de los espacios (fotos, equipo, capacidad)
- Información de los planes (precios, beneficios, max invitados)
- Número de WhatsApp comercial (formato E.164 sin "+")
- Datos legales: dirección, email, redes sociales

## Paso 1: Crear tenant en BD

Ejecutar en Supabase SQL editor (reemplazar placeholders):

```sql
INSERT INTO tenants (slug, nombre, vertical, config, branding, status)
VALUES (
  '<slug-cliente>',                -- ej: 'studio-cdmx'
  '<Nombre comercial>',            -- ej: 'Studio CDMX'
  'studio_creadores',
  jsonb_build_object(
    'reserva', jsonb_build_object(
      'duracion_default_min', 60,
      'cupos_por_recurso', 1,
      'permitir_continuas', false,
      'anticipacion_min_horas', 24,
      'anticipacion_max_dias', 30,
      'ventana_check_in_min', 15
    ),
    'penalizaciones', jsonb_build_object(
      'no_show_bloqueo_dias', 7,
      'no_show_acumular_para_baja', 3
    ),
    'contacto', jsonb_build_object(
      'whatsapp_e164', '<numero-real-cliente>',
      'whatsapp_mensaje_default', 'Hola, me interesa saber más.'
    ),
    'landing', jsonb_build_object(
      'hero', jsonb_build_object(
        'eyebrow', '<NOMBRE · CIUDAD>',
        'titulo', '<titulo principal>',
        'titulo_accent', '<accent>',
        'subtitulo', '<descripción del producto>',
        'cta_texto', 'Ver membresías →',
        'cta_link', '#membresias'
      ),
      'cta_final', jsonb_build_object(
        'eyebrow', '<CIUDAD · PAÍS>',
        'titulo', '<call to action>',
        'subtitulo', '<descripción>',
        'cta_texto', 'Contáctanos por WhatsApp →'
      ),
      'footer', jsonb_build_object(
        'tagline', '<tagline corto>',
        'copyright', 'Todos los derechos reservados.',
        'direccion', '<dirección física>',
        'email', '<email>',
        'redes', jsonb_build_object(
          'instagram', '<url>',
          'tiktok', NULL,
          'youtube', NULL,
          'facebook', NULL
        )
      )
    )
  ),
  jsonb_build_object(
    'logo_url', NULL,
    'color_primary', '#0A0A0A',
    'color_accent', '#E5B829',
    'color_bg', '#0A0A0A'
  ),
  'activo'
);
```

> **Nota** (post Sprint C-CRUD): Los SQLs de los Pasos 2 y 3 ya no son
> obligatorios. El cliente puede crear sus tiers y estudios directamente
> desde `/admin/tiers` y `/admin/recursos` con los botones "+ Nuevo". Los
> SQLs siguen siendo útiles para bulk-load inicial (10+ items de una vez).
>
> **Nota** (post Sprint D-Admin): el cliente nuevo puede:
> - Editar contenido de landing desde `/admin/landing`
> - Configurar WhatsApp + redes desde `/admin/contacto`
> - Ajustar reglas de reserva desde `/admin/reglas`
> - Previsualizar el producto desde el sidebar "VER COMO…"
>
> Todo sin tocar BD ni código. Hard delete con typed confirmation
> ("ELIMINAR") disponible solo desde la papelera para casos extremos.
>
> **Nota** (post Sprint D-Polish): cards de Estudios y Planes son
> horizontales con foto thumb + menú `⋯`. Click en cualquier parte
> del card abre el modal de editar. El menú `⋯` evita propagation y
> ofrece Editar / Duplicar / Eliminar. VER COMO en el sidebar abre
> Landing / Miembro / Recepción en pestañas separadas con banner
> sticky mostaza para volver al admin.
>
> **Nota** (post Sprint Equipo): `/admin/miembros` muestra SOLO
> clientes (`rol='miembro'`). Staff (admins + recepcionistas) se
> gestiona en `/admin/equipo`.
>
> **Nota** (post Sprint Fix Equipo): el botón es "+ Crear acceso"
> (antes "+ Invitar persona"). El admin escribe nombre + email +
> contraseña temporal + rol. La Edge Function
> `create-team-member` (deployada en Supabase) crea el auth user
> con esa contraseña + inserta el row en `usuarios` con
> `status='activo'`. Tras crear, aparece un modal con las
> credenciales y un botón "Copiar" — admin comparte por WhatsApp.
> No hay envío automático de email (pendiente Sprint Resend).
>
> Para el PRIMER admin de un tenant nuevo (que no tiene admin
> existente para usar el flow del UI), seguir el Paso 6 abajo:
> crear auth user en Supabase Dashboard + insertar row manualmente.

## Paso 2: Crear tiers (membresías)

```sql
INSERT INTO tiers (tenant_id, slug, nombre, descripcion, precio_centavos, moneda, periodo, beneficios, reglas, activo, orden)
VALUES (
  (SELECT id FROM tenants WHERE slug = '<slug-cliente>'),
  'basica',
  'Membresía Básica',
  'Para empezar.',
  120000,                          -- $1,200 MXN
  'MXN',
  'mensual',
  '["Acceso a estudios básicos", "Equipo profesional", "2 invitados por sesión"]'::jsonb,
  '{"max_invitados": 2}'::jsonb,
  true,
  1
);

-- Repetir para tier 'pro', 'plus', etc.
```

## Paso 3: Crear recursos (estudios/salas)

```sql
INSERT INTO recursos (tenant_id, slug, nombre, descripcion, tipo, cupos, capacidad_personas, horarios, tiers_permitidos, equipo_incluido, tipo_contenido, estilo_visual, foto_url, activo, orden)
VALUES (
  (SELECT id FROM tenants WHERE slug = '<slug-cliente>'),
  'estudio-1',
  'Estudio 1',
  'Descripción del espacio',
  'estudio_individual',
  1,
  6,
  '[{"dia":"lunes","inicio":"09:00","fin":"22:00"},{"dia":"martes","inicio":"09:00","fin":"22:00"}]'::jsonb,
  ARRAY['basica', 'pro'],
  ARRAY['Cámara Sony FX3', 'Micrófono Rode Wireless Pro'],
  ARRAY['Video', 'Podcast'],
  'Minimalista oscuro',
  NULL,                            -- se setea desde admin tras subir foto
  true,
  1
);
```

## Paso 4: Subir fotos a Storage

1. Loguearse como admin del tenant en `/admin/recursos`
2. Editar cada recurso → "Subir imagen"
3. Bucket `estudios/` (público) recibe el archivo
4. `foto_url` se actualiza automáticamente

Alternativa via SQL: subir manualmente al bucket, copiar URL pública,
`UPDATE recursos SET foto_url = '...' WHERE slug = '...'`.

## Paso 5: Configurar Auth

1. Habilitar email confirmations si es necesario
2. Configurar URL del tenant en Auth Site URL si tiene dominio custom
3. Configurar templates de email con branding del tenant

## Paso 6: Crear usuarios admin

```sql
-- 1. Crear auth.user desde Supabase Auth dashboard o via SQL helper.
-- 2. Insertar en usuarios:
INSERT INTO usuarios (auth_id, tenant_id, nombre, email, rol, status)
VALUES (
  '<auth-uuid>',
  (SELECT id FROM tenants WHERE slug = '<slug-cliente>'),
  '<nombre>',
  '<email>',
  'admin',
  'activo'
);
```

## Paso 7: Stripe (cuando esté implementado)

Pendiente: documentar flow de Stripe Connect o cuenta separada
por tenant.

## Paso 8: QA pre-launch

- [ ] Landing renderiza con textos correctos
- [ ] Logo y branding correctos (cuando Sprint D esté listo)
- [ ] WhatsApp redirige al número correcto
- [ ] Estudios aparecen con fotos
- [ ] Tiers aparecen con precios correctos
- [ ] Signup funciona end-to-end
- [ ] Admin puede editar config desde `/admin/configuracion`
- [ ] Admin puede crear/editar recursos
- [ ] Recepcionista puede hacer check-in
- [ ] Miembro puede reservar (anticipación, horario, tier respetados)

## Paso 9: Dominio custom (opcional)

1. Cliente apunta DNS al CNAME de Netlify
2. Configurar dominio custom en Netlify
3. Actualizar Auth Site URL en Supabase
4. Actualizar Stripe webhook URLs (cuando aplique)

## Paso 10: Handover

- [ ] Pasar credenciales admin al cliente
- [ ] Capacitar al cliente en uso de admin (1 sesión de 1hr)
- [ ] Entregar documentación de uso (PDF)
- [ ] Configurar canal de soporte (WhatsApp Business)

## Troubleshooting común

### "El landing está vacío"

Probable: el tenant existe pero `config.landing` no se sembró.
Aplicá la migración `20260517200000_landing_cms_phase1.sql` o
hacé `UPDATE tenants SET config = config || ...` con los bloques
del Paso 1.

### "El miembro no puede reservar — EKKO_TIER_NO_PERMITIDO"

`recursos.tiers_permitidos` no incluye el `membresia_tier` del
usuario. Ajustar en `/admin/recursos`.

### "No me deja reservar antes de 24h"

`config.reserva.anticipacion_min_horas` está en 24. Cambiar en
`/admin/configuracion` o vía SQL:

```sql
UPDATE tenants
SET config = jsonb_set(config, '{reserva,anticipacion_min_horas}', '12'::jsonb)
WHERE slug = '<slug-cliente>';
```

### "Click en CTA WhatsApp no abre nada"

`config.contacto.whatsapp_e164` está vacío. El componente render
condicional muestra "(Contacto sin configurar)" en lugar del botón.
Configurar en admin → contacto.
