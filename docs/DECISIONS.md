# Decisiones arquitectónicas — SALA Studio

## D-001: Multi-tenant desde día 1

**Decisión**: toda la BD lleva `tenant_id`, los RPCs leen `tenants.config jsonb`
para reglas de negocio variables, la UI tiene componentes intercambiables por
`tenant.vertical`.

**Razón**: SALA Studio es producto SaaS desde el día 1 (vendible a estudios
de yoga, pilates, gym, cycling, crossfit). El primer tenant operacional será
`sala-demo`. Construir single-tenant ahora y refactorizar después cuesta 3x;
el costo de arrancar multi-tenant es 15-20% extra en Fase 1.

**Trade-off aceptado**: complejidad inicial mayor, RLS más estricto, RPCs
más generales.

## D-002: Un solo repo, una sola app Vite, 4 layouts por path

**Decisión**: NO monorepo con workspaces. NO repos separados. UN repo, UNA app
Vite, code splitting con `React.lazy` por layout. Rutas `/`, `/app/*`,
`/admin/*`, `/recepcion`.

**Razón**: equipo de 1 (+ Claude Code), build <30s, un solo dominio. Workspaces
serían 1-2 días de configuración que no compran nada. Repos separados duplican
cliente Supabase, tipos, deploys.

## D-003: Reglas de negocio en BD, no en código

**Decisión**: `tenants.config jsonb` guarda flags como `permitir_continuas`,
`duracion_default_min`, `cupos_por_recurso`. Los RPCs leen este config.

**Razón**: agregar un vertical nuevo (yoga/pilates) NO requiere tocar código de
backend, solo crear un tenant con su config. Cero `if (tenant.slug === 'sala-demo')`.

## D-004: Toda llamada externa pasa por Netlify Functions

**Decisión**: ninguna API key (Stripe, Anthropic futuro, JWT secret, etc.) vive
en el cliente. Cada llamada externa pasa por una función serverless que valida
auth Supabase y hace el request server-side.

**Razón**: lección directa de HSC (§15 de su dossier): API key en cliente es
bomba de costo y seguridad. SALA no repite ese error.

## D-005: Mobile-first hardening copiado completo de HSC

**Decisión**: `100dvh` (no `100vh`), `safe-area-inset` en todos los layouts
con bottom nav o headers, anti-zoom iOS (`font-size: 16px` en inputs ≤768px),
tap targets ≥44px (Apple HIG), body scroll lock en modales/players,
`createPortal` para overlays full-screen, `prefers-reduced-motion` respetado.

**Razón**: HSC ya pagó el costo de aprenderlo. Copiamos el patrón completo.

## D-006: Auth deadlock fix de Supabase v2 desde día 1

**Decisión**: NUNCA hacer `await supabase.from(...)` dentro del callback de
`onAuthStateChange`. Diferir con `setTimeout(() => { ... }, 0)`.

**Razón**: Supabase JS v2 tiene un deadlock conocido (HSC §10). Lo metemos
preventivo, no esperamos a que pase.

## D-007: TypeScript desde día 1

**Decisión**: 100% TypeScript con strict mode. Tipos de BD auto-generados
con `supabase gen types typescript --linked`.

**Razón**: schema drift es lo que mordió a HSC. Los tipos generados gritan
en el IDE cuando una columna no existe.

## D-008: Sentry + Playwright smokes desde día 1

**Decisión**: Sentry frontend + functions + source maps upload condicional.
Playwright smokes contra producción con cuentas de prueba, cron diario.

**Razón**: operar a ciegas (como HSC) significa que las regresiones las
encuentra el cliente, no el equipo. Costo: una tarde de setup.

## D-009: CSS namespaced + Tailwind para utilities

**Decisión**: tokens y componentes-firma en CSS custom (`.ek-*`, `tokens.css`,
`reset.css`, `sala.css`). Tailwind solo para utilities mobile (`h-dvh`,
safe-area-spacing, breakpoints, flexbox helpers).

**Razón**: Tailwind puro lleva a clases gigantes ilegibles para CTAs/cards
recurrentes. CSS namespaced mantiene legibilidad y portabilidad de componentes.

## D-010: política de `membresias.status='past_due'` — diferida a Stripe

**Decisión actual**: el gate de `reservar_clase_atomic` (Fase 2A.2,
`20260524200000`) considera `past_due` como uno de los estados que permiten
reservar (junto con `trialing` y `activa`). `congelada` bloquea.

**Razón de diferir**: hoy NADA en el sistema pone a un socio en `past_due` —
es un estado que solo va a aparecer cuando integremos Stripe (webhook
`invoice.payment_failed`). Mientras no exista esa entrada, definir "qué hace
past_due" es teórico y sin tester real.

**Pendiente de decidir al integrar Stripe**: bajo el modelo prepago estricto
`past_due` debería **bloquear** la reserva (no pagó, no entra). La alternativa
es un **período de gracia configurable** (e.g. 3 días entre fallo de cobro y
bloqueo efectivo) que se sostiene en `tenants.config.reserva.gracia_past_due_dias`
con default 0 (bloqueo inmediato).

**Cuando se decida**: ajustar el gate para excluir `past_due` del set de
estados que pasan, o agregar la lógica de gracia. Hoy es una línea: cambiar
`('trialing', 'activa', 'past_due', 'congelada')` → `('trialing', 'activa', 'congelada')`
en el WHERE del SELECT del gate (y dejar `congelada` con su error explícito).

## D-011: asimetría de lista de espera — la promoción no debita crédito (RESUELTO)

**Resuelto en**: `20260526100000_lista_espera_debita_credito.sql` (opción 1
del diseño original + opción (c) para el 5º agujero descubierto durante el
sprint).

**Resumen de la resolución** — cerrados los 5 agujeros de balance:
1. `anotar_lista_espera` ahora debita 1 crédito al anotarse (mismo gate que
   `reservar_clase_atomic`: SIN_MEMBRESIA / VENCIDA / CONGELADA / SIN_CREDITOS;
   solo rol miembro + tier creditos/hibrido; FOR UPDATE serializa).
2. `salir_lista_espera` devuelve el crédito si había debitado (anti-doble por
   `lista_espera_id`); bloquea CLASE_PASADA.
3. `trg_limpiar_espera_clase_cancelada` amplificado: refund por entrada cuando
   el admin cancela la clase.
4. Nueva `expirar_listas_espera_vencidas()` (cron-callable, llamada desde
   `cron-no-shows` cada hora): marca entradas 'esperando' con slot pasado
   como 'expirada' y devuelve crédito si había débito.
5. `cancelar_reserva_atomic` con fallback al origen lista_espera: si la
   reserva vino de promoción (sin débito por reserva_id), busca el débito
   por el `lista_espera_id` de la entrada con status='promovido' que apunta
   a esa reserva. Devolución se inserta con AMBAS claves (reserva_id +
   lista_espera_id) → anti-doble cierra por cualquier vía.

**Ledger inmutable preservado** — se descartó re-vincular el débito (UPDATE
de `reserva_id` en el ledger) porque viola `trg_membresia_mov_no_update`. El
fallback de lectura es la solución limpia: el patrón append-only sigue intacto.

**Tests**: `scripts/test_lista_espera_credito.sql` (15 casos: gate, refund,
expiración cron, idempotencia, balance global, fallback de promovida,
camino feliz normal). Los 19 SQL anteriores + 145 vitest siguen verdes (la
shape jsonb de `cancelar_reserva_atomic` no cambia y el fallback solo corre
cuando el primer count por reserva_id da 0).

---

**Histórico (problema y diagnóstico originales)**

**Severidad**: **alta — prioritaria antes de cobrar créditos reales en
producción**. Pierde dinero al gym (1 crédito por cada promoción exitosa).

**Bug**: cuando un socio cancela A TIEMPO (Fase 2B,
`20260524400000_cancelar_reserva_gate_y_devolucion.sql`), `cancelar_reserva_atomic`
le devuelve 1 crédito. El trigger `reservas_promover_lista_espera`
(`20260520150000_lista_espera.sql:272`) dispara y `_promover_entrada` crea una
reserva confirmada para el primero de la cola — pero **NO debita 1 crédito** al
promovido. Resultado: el gym devolvió 1 crédito al cancelador y regaló 1 clase
al promovido. Balance global: −1 crédito por cada promoción exitosa.

**5º agujero descubierto durante el sprint**: si B se anota (debita), es
promovido (entrada 'promovido', reserva sin débito propio) y luego cancela
A TIEMPO, el `cancelar_reserva_atomic` original buscaba débito por reserva_id
y no encontraba → el SOCIO perdía el crédito que pagó al anotarse. Peor que
el gym regalando: acá pierde el cliente. Cubierto por la opción (c) del
fallback.

## D-012: mismatch de clave en `tenants.config.reserva.anticipacion_min_horas`

**Severidad**: media — los tenants nuevos ignoran silenciosamente su config
de anticipación mínima.

**Bug**: `crear_tenant_onboarding` siembra la clave **anidada** en
`config.reserva.anticipacion_min_horas` (`20260522200000_drop_recursos_horarios.sql:70`).
Pero `reservar_clase_atomic` la lee **top-level** como
`config->>'min_anticipacion_horas'` (`20260524200000_reservar_clase_gate.sql:225`).
Dos diferencias:
1. Path (`config.reserva.X` vs `config.X`).
2. Orden de tokens (`anticipacion_min_horas` vs `min_anticipacion_horas`).

Resultado: para los tenants creados por el onboarding nuevo, el COALESCE del
RPC siempre cae al default (`24` horas). El valor del config se ignora.
`sala-demo` (creado a mano antes del onboarding) probablemente tampoco tenga
la clave correcta — habría que auditar.

**Recomendación**: alinear con la convención del path anidado (`config.reserva.X`)
que ya usa Fase 2B para `cancelacion_min_horas`, y elegir UNA forma del
nombre. Sugiero `config.reserva.anticipacion_min_horas` (lo que ya escribe el
onboarding) — solo hay que cambiar la lectura en `reservar_clase_atomic`.

**Cuando se ataque**: una migración corta que reescribe
`reservar_clase_atomic` cambiando la línea:
`COALESCE((v_tenant.config->>'min_anticipacion_horas')::integer, 24)`
→ `COALESCE((v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer, 24)`.
Más test que un tenant con `anticipacion_min_horas=2` en su config realmente
permita reservar con 2h de anticipación.

## D-013: `status='cancelada_admin'` no está en el CHECK de `reservas`

**Severidad**: media — un flujo del front admin está roto silencioso.

**Bug**: el CHECK constraint de `reservas.status`
(`20260514100500_reservas.sql:25`) permite solo
`('confirmada', 'cancelada', 'completada', 'no_show')`. Pero
`src/admin/lib/crudHelpers.ts:294` hace `UPDATE reservas SET
status='cancelada_admin'`. Ese UPDATE debería fallar el CHECK constraint y
devolver error al front cuando un admin intenta cancelar una reserva desde
la UI de administración.

El trigger `reservas_promover_lista_espera`
(`20260520150000_lista_espera.sql:278`) menciona `cancelada_admin` como uno
de los estados que dispara la promoción — pero como el valor nunca puede
escribirse, ese branch del trigger es código muerto.

**Tres opciones**:
1. **Agregar `'cancelada_admin'` al CHECK** y mantener el comportamiento que
   el front intenta hacer (distinguir cancelación por admin de
   auto-cancelación del socio en reportes/UX).
2. **Borrar el código del front** y usar siempre `'cancelada'` con
   `cancelada_por` para distinguir quién canceló.
3. **Migrar el front al RPC** `cancelar_reserva_atomic` (que ahora soporta
   admin cancelando, Fase 2B) — gana atomicidad, ventana de cancelación,
   devolución de crédito.

**Recomendación**: opción 3. El front admin debería usar el RPC, no UPDATE
directo. Eso le da gratis: ventana, devolución de crédito, notificación
limpia. Y elimina la inconsistencia.

**Cuando se ataque**: refactor del modal de cancelación del admin
(`src/admin/components/CancelarReservaModal.tsx`) para llamar
`cancelar_reserva_atomic` en lugar de UPDATE directo. Borrar el branch
muerto del trigger de lista de espera (`OLD.status='cancelada_admin'`).

## D-014: gate de membresía lee `usuario.membresia_tier` en vez de JOIN a `tiers`

**Severidad**: baja — funcional, pero desnormalización rara.

**Bug**: `reservar_clase_atomic` y `anotar_lista_espera` verifican el tier
del socio leyendo `usuario.membresia_tier` (string) y comparándolo contra
`recurso.tiers_permitidos`. Es una columna desnormalizada que se sincroniza
desde `membresias.tier_id` vía RPC (`gestionar_membresia_socio` setea ambos),
pero abre la puerta a inconsistencia: si por algún motivo `usuario.
membresia_tier` queda desfasada de la membresía activa real, el gate evalúa
sobre el dato viejo.

**Cuando se ataque**: refactorear el gate para JOIN directo
`membresias → tiers → tiers_permitidos`. Es una línea de SQL más por gate,
pero elimina la columna desnormalizada (o al menos la deja como cache no
autoritativo). Anotado originalmente en
`20260524500000_gestionar_membresia_socio.sql:41`.

## D-015: ícono PWA — look app-nativa con fondo verde de marca (resuelto)

**Decisión final** (PWA, mayo 2026): los íconos generados por
`scripts/generate-pwa-icons.mjs` usan **símbolo blanco sobre fondo verde de
marca `#3D6B52`** (= `--sala-primary`). Aplica a `icon-192.png`,
`icon-512.png`, `apple-touch-icon.png` y `favicon.ico` — look app-nativa
coherente en Android (maskable), iOS y escritorio.

**Excepción de diseño — favicon.svg**: el SVG que los browsers modernos
preferencian para pestañas (vía `<link rel="icon" type="image/svg+xml">`)
usa el símbolo VERDE sobre fondo BLANCO. Razón: una pestaña suele
renderizarse sobre fondo claro del browser, donde un símbolo blanco
desaparecería. Para mantener legibilidad en cualquier tema de browser,
favicon.svg viene de una fuente separada (`public/sala-favicon-source.svg`)
con la versión verde-sobre-blanco. El `.ico` (fallback para browsers viejos)
sí lleva el branding completo (símbolo blanco sobre verde).

**Estructura de fuentes**:
  - `public/sala-icon-source.svg` → fuente principal (símbolo blanco con
    fondo transparente). Genera los 192/512/apple-touch/.ico, todos con
    flatten contra `#3D6B52`.
  - `public/sala-favicon-source.svg` → fuente alterna solo para
    favicon.svg (verde sobre blanco). Si no existe, el script hace fallback
    a la fuente principal con un warning.

**Iteración previa** (también documentada): la primera versión usaba el
símbolo verde sobre fondo blanco en TODOS los íconos. Funcional pero menos
"app-nativa". Se reemplazó cuando llegó la versión blanca del logo (mayo 2026).

## D-016: favicon dinámico por tenant (white-label)

**Estado**: campo `branding.favicon_url` ya existe + editor en AjustesMarca
sube el archivo a Supabase Storage. **Pero el front no lo lee** —
`index.html:5-6` hardcodea `<link rel="icon" href="/favicon.svg">` con el
favicon de SALA. Un admin sube su favicon, ve "Marca actualizada" y la
pestaña sigue mostrando SALA.

**Severidad**: white-label — importante para diferenciación vs competidores.
NO bloquea operación (la app funciona; solo se ve "SALA" en la pestaña en
lugar del gimnasio). Pero sí rompe la promesa de white-label.

**Solución**: inyectar el `<link rel="icon">` dinámico al cargar el tenant
(en TenantProvider, después de setear `document.title`). Si
`branding.favicon_url` existe, reemplaza el `href` del `<link>`. Para PWA
manifest hace falta más trabajo (manifest dinámico vía endpoint o
generación al vuelo) — eso es D-018.

**Cuando se ataque** (junto con D-018 idealmente): manipular DOM al cargar
tenant para reemplazar favicon `<link>` + theme-color `<meta>` +
apple-touch-icon. Anotar en KERNEL la lista de tags dinámicos.

## D-017: colores dinámicos por tenant (white-label) — RESUELTO (Fase A)

**Resuelto en**: refactor Fase A del sistema de color dinámico, junto con
fix del bug semántico .ek-cta--danger:hover (antes usaba accent-hover en
vez de error-hover, cambio de hue rojo→coral).

**Resumen de la resolución**:

1. **CSS** ([src/styles/sala.css](src/styles/sala.css)): `:root` reescrito
   con el contrato Fase A — 4 bases dinámicas (--sala-primary/-text/-tint y
   accent), 20 derivados color-mix (hover/active/light/soft/shadow/dim/
   glow/glow-strong/focus-ring/darkest × {primary, accent}), 4 derivados
   error (-hover/-shadow/-dim/-glow), 1 ancla fija (--sala-neutral-dark
   #0A0F0C para evitar marrón con primarios amarillos), y bloque
   @supports fallback con literales SALA para navegadores sin color-mix
   (Safari <16.2 / Chrome <111, <1% mercado MX). 21 instancias rgba
   hardcoded migradas a vars derivadas.

2. **TenantProvider** ([src/shared/providers/TenantProvider.tsx](src/shared/providers/TenantProvider.tsx)):
   `applyBranding()` exportado que escribe los 6 flags dinámicos al
   :root al cargar tenant. Helpers `relativeLuminance`, `pickTextOn`
   (umbral 0.55, decide texto blanco/casi-negro WCAG), `pickHoverTint`
   (umbral 0.06, decide darken vs lighten — SALA L=0.121 cae en darken).

3. **AjustesMarca** ([src/admin/pages/AjustesMarca.tsx](src/admin/pages/AjustesMarca.tsx)):
   sección COLORES nueva con 2 color pickers (primary + accent), preview
   chip strip de los 8 derivados de cada base, preview de botones reales,
   warning fuerte si contraste < 4.5:1 (WCAG AA texto), warning soft si
   primario muy claro (L > 0.75), botón "Restablecer verde SALA".
   **Preview en tiempo real**: al mover el picker, applyBranding aplica
   los colores a toda la app sin guardar — el botón "Descartar" revierte
   al estado persistido si el admin cambia de opinión.

4. **Decisión arquitectónica**: solo `color_primary` y `color_accent`
   fluyen con el tenant. `color_bg`, `--sala-surface` y neutros se
   quedan fijos (patrón Stripe/Linear: marca en acentos, superficies
   neutras). Cambiar el bg requeriría re-tunear text/borders enteros —
   fuera de scope.

5. **Recharts** ([src/admin/pages/Reportes.tsx](src/admin/pages/Reportes.tsx)):
   recharts no entiende CSS vars, así que se agregó hook `useChartColors()`
   que lee `tenant.branding.color_primary/color_accent` y devuelve hex.
   Charts ya se tiñen con el color del tenant.

6. **Tailwind config**: brand colors (sala.primary, ek-mustard, etc.)
   eliminados del config — verificado con grep sistemático que 0
   componentes usaban Tailwind brand classes. Tailwind ahora solo entrega
   utilities ortogonales (layout/spacing/fonts/screens).

**Validación de regresión cero** (script + 3 capas, ver
[scripts/validate-color-regression.mjs](scripts/validate-color-regression.mjs)):
con SALA verde #3D6B52, todos los derivados primary matchean los
literales actuales dentro de ≤5 RGB units por canal o ≤3% alpha — la
prueba matemática confirma regresión imperceptible. Caso especial: el
único delta significativo (accent-hover Δ=32) corresponde a un valor
hand-tuned que SOLO se usaba en una regla con bug semántico
(.ek-cta--danger:hover usando accent-hover); el refactor aprovechó para
fixearla y la "regresión" no se ve en ningún píxel real.

**Cobertura de extremos** (validada con sanity-check del script):
primarios navy (#0A1628 ultra-oscuro), amarillo (#F4D35E claro) y rojo
(#E63946 saturado) producen derivados razonables — navy hovers con
lighten, amarillo texto negro automático, rojo con todos los tonos en
familia. El amarillo en -darkest queda olive oscuro (no marrón) gracias
al ancla --sala-neutral-dark.

**Pendientes documentados**:
- D-018 sigue abierto (manifest PWA + meta tags dinámicos).
- D-021 nueva (ver abajo): refuerzo de borde para -light con primarios muy
  claros — Fase B del sistema de color.

## D-018: head injection dinámica (white-label — meta tags / OG / theme-color)

**Estado**: `index.html` tiene meta tags estáticos:
  - `<meta name="theme-color" content="#3D6B52">` (status bar móvil)
  - `<meta name="apple-mobile-web-app-title" content="SALA">` (nombre PWA en iOS)
  - `<meta property="og:title" content="SALA Studio">` (preview compartido)
  - `<meta property="og:description" content="Reserva clases, gestiona membresías…">`
  - **NO hay `<meta property="og:image">`** aunque AjustesMarca sube
    `branding.og_image_url` (otra pieza inerte).
  - **Manifest PWA (`vite.config.ts` VitePWA.manifest)** también estático:
    `name: 'SALA Studio'`, `short_name: 'SALA'`, `icons: /icons/icon-{192,512}.png`
    (los de SALA). Cuando el socio de `gym-x.salastudio.app` toca "Instalar"
    en el banner PWA (`<PwaInstallBanner>`), la app queda en su pantalla de
    inicio con el ícono y nombre de SALA, no del gym. El banner solo invita
    a instalar — la identidad de lo instalado depende de esta deuda.

**Severidad**: white-label. Cuando un gimnasio comparte su URL por
WhatsApp/redes, el preview dice "SALA Studio", no el gym. La status bar
móvil es verde SALA siempre. El nombre del ícono PWA en iOS dice "SALA".
Y al instalar como PWA, el home del socio muestra "SALA" + isotipo verde de
SALA, no la marca del gym.

**Solución**: inyectar / actualizar meta tags al cargar tenant
(`TenantProvider` después del título). Lista mínima a manipular:
  - `<meta name="theme-color">` con `branding.color_primary` (cuando D-017)
  - `<meta name="apple-mobile-web-app-title">` con `tenant.nombre`
  - `<meta property="og:title">` con `tenant.nombre`
  - `<meta property="og:description">` con un campo nuevo
    `branding.tagline_seo` o derivado del landing_config
  - `<meta property="og:image">` con `branding.og_image_url`
  - `<link rel="icon">` con `branding.favicon_url` (D-016)
  - Manifest PWA dinámico: servir `/manifest.webmanifest` desde un endpoint
    (Netlify Function por subdominio) o generar uno por tenant con
    `branding.logo_url`/`isotipo_url` como `icons` y `tenant.nombre` como
    `name`/`short_name`. Esto es lo que define el ícono y nombre que
    aparece en home tras instalar via `<PwaInstallBanner>`.

**Caveat**: los meta OG los lee el crawler de WhatsApp/Twitter/etc. ANTES
de que el JS de la app corra. Si la app es SPA pura, el crawler ve el HTML
estático sin las modificaciones. Para que el OG funcione de verdad en
preview de WhatsApp hace falta:
  - Edge/Netlify Function que genera HTML SSR con los meta del tenant
    según el subdominio, O
  - Pre-render por subdominio (más complejo).
Para favicon/theme-color/title sí alcanza con manipular DOM en runtime
(el browser actualiza la pestaña/status bar después de cargar JS).

**Severidad por sub-pieza**:
  - theme-color, apple-web-app-title, favicon (runtime): media — solo
    afecta visual de quien tiene la app abierta. Implementable con DOM
    manipulation simple, junto con D-016.
  - og:title / og:description / og:image (crawlers): alta — requiere SSR.
    Mucho más caro de implementar.

**Cuando se ataque**: hacer primero la parte runtime (junto con D-016 y
D-017). La parte SSR/OG para crawlers puede quedar D-018b si el SaaS
explota y vale el esfuerzo de configurar Netlify Functions con HTML
custom por subdominio.

## D-019: flag `hide_powered_by` debería derivarse del plan SaaS, no manual

**Severidad**: baja — hoy funciona, pero acopla mal cuando exista Stripe.

**Estado actual**: el footer `<PoweredBySala>` (presente en Login, Member,
Admin sidebar, Recepción, landing público) se oculta cuando el tenant tiene
`branding.hide_powered_by === true`. Es un flag MANUAL — alguien (admin de
SALA, no del gym) lo prende a mano para clientes premium.

**Por qué se hizo así (opción A)**: cuando se construyó el footer
(`feat(branding): Powered by SALA footer ...`), Stripe seguía mockeado y
`suscripciones_saas` tenía `mock_cus_*` hardcoded. Conectar el flag a "plan
premium" requería primero tener el plan real funcionando — y eso es un
sprint entero. La opción A (flag manual) cubre el caso de los primeros
clientes premium sin bloquear la entrega.

**Lo que falta**: cuando Stripe esté conectado de verdad, el flag debería
derivarse del tier del SaaS (ej. `suscripciones_saas.tier IN ('premium',
'enterprise')` → ocultar; `'basic' o 'trial'` → mostrar). Un sólo lugar
de verdad. Hoy hay riesgo de drift: un gym puede pagar premium y nadie le
prende el flag, o dejar de pagar y nadie se lo apaga.

**Cuando se ataque**: junto con la integración real de Stripe (`webhooks
+ suscripciones_saas` autoritativo). Cambiar
`PoweredBySala.tsx:if (branding.hide_powered_by === true)` por algo como
`if (suscripcionPremium(tenant.suscripcion))`. El campo manual
`branding.hide_powered_by` puede quedar como override de soporte (gym
beta-tester sin pagar pero acordado que no lleva footer) o eliminarse.

## D-020: localizar TODA la app a español mexicano (hoy es voseo rioplatense)

**Severidad**: alta para el mercado objetivo. Toda la UX habla en un
dialecto que el cliente final no usa — siente "ajeno".

**Estado actual**: la app entera usa **voseo rioplatense** (Argentina,
Uruguay) en mensajes de cara al usuario. Ejemplos detectables con
`grep -rn "tenés\|tocá\|elegí\|cancelá\|mirá\|recargá\|contactá" src/`:
  - Errores RPC: `SIN_CREDITOS: "Te quedaste sin créditos en tu paquete"`,
    `USUARIO_BLOQUEADO: "Tenés una restricción activa"`, etc.
  - Login: `"Necesitás confirmar tu email primero"`.
  - AjustesMarca: `"Recargá para ver los cambios"`.
  - PwaInstallBanner: `"Instalá la app"`, `"Tocá ⎙ y elegí..."`.
  - MemberLayout (status fail): `"Contactá al administrador"`.
  - Mensajes inline en componentes de reservas/cancelaciones.

**Mercado objetivo**: México (primer cliente real estimado en Culiacán,
Sinaloa). Allá el voseo no se usa — el registro estándar es **tuteo
mexicano**: instala/toca/elige/cancela/mira/recarga/contacta. El voseo
genera fricción cultural inmediata ("esto no fue hecho para nosotros").

**Alcance**: transversal. Toca al menos:
  - Migraciones SQL (mensajes de `RAISE EXCEPTION` en RPCs — los más
    visibles porque llegan al toast del cliente).
  - Componentes React de los 4 layouts (member/admin/recepción/público).
  - Textos de marketing/landing.
  - Toast/error helpers (`traducirError`, `traducirErrorRPC`).

**Por qué no se ataca acá**: es tarea transversal de pulido, no scope de
un sprint funcional. Requiere pasada uniforme + revisión (no es
"buscar-reemplazar tenés→tienes" porque hay matices: "podés" → "puedes",
"querés" → "quieres", también imperativos sin acento: "mirá" → "mira",
"contactá" → "contacta"). Y cada cambio en SQL es una migración nueva
que debés ejecutar en Supabase.

**Cuando se ataque**: sprint dedicado "L10n MX" antes del primer cliente
real. Estrategia sugerida:
  1. Pasada por SQL (mensajes de `RAISE EXCEPTION`) — una migración con
     `CREATE OR REPLACE FUNCTION` por cada RPC tocada. Tests SQL
     existentes siguen verdes (matchean por prefijo `'SIN_CREDITOS%'`).
  2. Pasada por React (search & replace con revisión humana caso por
     caso — los falsos positivos son raros pero existen).
  3. Considerar i18n real (`react-i18next`) si en algún momento aparece
     un cliente de Argentina/Uruguay/España que justifique multi-locale.
     Hoy se asume un solo idioma destino → mover strings es suficiente,
     no hace falta sistema de i18n completo.

## D-021: refuerzo visual del -light con primarios muy claros (Fase B color)

**Severidad**: baja — degradación visual cosmética, no funcional.

**Estado**: el derivado `--sala-primary-light` (Fase A, D-017) es
`color-mix(in srgb, var(--sala-primary) 10%, var(--sala-bg))` — mezcla 10%
del primario sobre el fondo cremita. Funciona bien para primarios
saturados (verde SALA, navy, rojo), pero con primarios MUY CLAROS
(luminancia > 0.75: amarillo pastel, lila pastel, celeste claro), el
`-light` resulta indistinguible del fondo de la app.

Hoy hay un warning suave en AjustesMarca cuando el admin elige un
primario con L > 0.75: *"Este color es muy claro — los fondos suaves
podrían no diferenciarse bien del fondo de la app."* Eso educa, pero no
arregla.

**Mitigación propuesta (Fase B)**: cuando se detecte un primario claro,
los elementos que hoy usan solo `background: var(--sala-primary-light)`
deberían además agregar un borde sutil para mantener la silueta. Por
ejemplo:

```css
.ek-status-pill--primary {
  background: var(--sala-primary-light);
  border: 0.5px solid var(--sala-primary-dim);  /* refuerza la silueta */
}
```

Implementación: identificar las 5-10 reglas que usan `-light` como fondo
sin border, agregarles `border: 0.5px solid var(--sala-primary-dim)` (o
similar). El borde es invisible para primarios saturados (donde `-light`
ya contrasta) y funciona como anchor visual para los pastel.

Alternativa más compleja: precomputar JS-side un % de mezcla dinámico
para `-light` (8% para colores oscuros, 25% para claros). Requiere otra
var JS-decidida tipo `--sala-primary-light-mix`. Más correcto pero más
complejo — solo si la Opción A (borde) no cubre el caso.

**Cuando se ataque**: Fase B de elevación visual premium. En ese sprint
ya estaremos auditando glows / shadows / gradientes para "elevar el
diseño con técnicas premium" — agregar el border refuerzo cabe en el
mismo paso.
