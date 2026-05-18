# EKKO Studio

Sistema operativo de EKKO Studio — club de creadores de contenido en Culiacán, México.
Primer tenant del producto SaaS multi-tenant **SALA**.

## Stack

React 18 + TypeScript + Vite 6 · Tailwind 3 · Supabase (Postgres + Auth + RLS + Storage)
· Zustand (persist) · Stripe Subscriptions · Netlify Functions · Sentry · Vitest +
Playwright · vite-plugin-pwa.

## Arquitectura

App única, 4 layouts por path (code splitting con `React.lazy`):

- `/` → sitio web público (marketing)
- `/app/*` → PWA del miembro (login, reservas, QR)
- `/admin/*` → panel admin
- `/recepcion` → pantalla kiosco para escaneo QR

Multi-tenant desde día 1 (`tenant_id` en cada tabla, RLS por tenant + rol).

## Setup local

```bash
npm install
cp .env.example .env.local   # rellena las credenciales
npm run dev                  # → http://localhost:5173
```

Para correr con Netlify Functions localmente:

```bash
npx netlify dev
```

## Comandos

| Comando | Descripción |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | TypeScript check + Vite build |
| `npm run preview` | Preview del build de producción |
| `npm run lint` | ESLint sobre todo el repo |
| `npm test` | Vitest (unit) |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:e2e` | Playwright (E2E smokes) |
| `npm run supabase:types` | Regenera tipos TypeScript desde la BD |

## Estructura

```
ekko-studio/
├── src/
│   ├── shared/           # código sin opinión de layout (libs, hooks, utils, types, ui-kit)
│   ├── public/           # layout web pública
│   ├── member/           # layout PWA del miembro
│   ├── admin/            # layout admin
│   ├── reception/        # layout recepción (kiosco)
│   └── styles/           # tokens.css, reset.css, ekko.css (design system)
├── netlify/functions/    # serverless (stripe, qr, admin ops)
├── supabase/migrations/  # schema versionado
├── e2e/                  # Playwright specs
└── docs/                 # decisiones, deployment, runbooks
```

## Convenciones

- **Multi-tenant primero**: cada tabla operativa lleva `tenant_id`; cada query lo filtra.
- **Reglas de negocio en BD**, no en código: usar `tenants.config jsonb` para flags por vertical.
- **Componentes < 500 líneas**: extraer lógica pura a `*Logic.ts` testeable.
- **CSS namespaced**: cada scope tiene prefijo (`.ek-*` compartido, `.wp-*` workout player, etc.).
- **Toda llamada externa pasa por Netlify Functions** (nunca API keys en cliente).
- **Mobile-first hardening**: `h-dvh`, safe-area-inset, tap targets 44px, anti-zoom iOS.

## Ownership

STRYV Studio · Cliente fundador: EKKO Studio (Cravia)
