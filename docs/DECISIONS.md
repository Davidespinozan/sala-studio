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
