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

## D-011: asimetría de lista de espera — la promoción no debita crédito

**Severidad**: **alta — prioritaria antes de cobrar créditos reales en
producción**. Pierde dinero al gym (1 crédito por cada promoción exitosa).

**Bug**: cuando un socio cancela A TIEMPO (Fase 2B,
`20260524400000_cancelar_reserva_gate_y_devolucion.sql`), `cancelar_reserva_atomic`
le devuelve 1 crédito. El trigger `reservas_promover_lista_espera`
(`20260520150000_lista_espera.sql:272`) dispara y `_promover_entrada` crea una
reserva confirmada para el primero de la cola — pero **NO debita 1 crédito** al
promovido. Resultado: el gym devolvió 1 crédito al cancelador y regaló 1 clase
al promovido. Balance global: −1 crédito por cada promoción exitosa.

**Por qué se aceptó así en Fase 2A.2**: el comentario en
`20260524200000_reservar_clase_gate.sql` lo anota: *"_promover_entrada no
debita: la idea es que el crédito ya se reservó cuando el socio se anotó.
Pendiente de definir en Fase 2B."* Pero en Fase 2B tampoco se atacó —
anotar_lista_espera tampoco debita al anotarse en cola.

**Opciones para resolver**:
1. **Debitar al anotarse en la lista de espera** (`anotar_lista_espera`): el
   socio "reserva" su crédito desde la cola. Si nunca se promueve, devolver
   automáticamente al expirar la clase (cron) o cuando el socio se desinscribe.
   Pro: simétrico, ya hay un crédito en juego cuando se promueve. Con:
   complica `anotar_lista_espera` y agrega un flujo de devolución de cola.
2. **Debitar al promoverse** (en `_promover_entrada`): el helper actual
   bypasea el gate. Habría que agregar el chequeo del saldo del promovido
   ANTES de promover. Si está sin créditos, saltarlo y promover al siguiente.
   Pro: el gate vive en un solo lugar conceptual. Con: complica el helper y
   puede dejar la cola sin promover si nadie tiene saldo.

**Recomendación**: opción 1 (debitar al anotarse). Es la convención típica
de gyms: te anotás → ya "pagás" el lugar; si no se libera, te devuelven.

**Cuando se ataque**: tocar `anotar_lista_espera` para que debite + crear
flujo de devolución para entradas que expiran (clase pasada o socio se
desinscribe). Tests para que la suma siempre cierre en cero (lo que el socio
gastó debe matchear lo que se le devolvió).

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
