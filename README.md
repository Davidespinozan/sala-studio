# SALA Studio

Plataforma SaaS para gimnasios, yoga studios, spinning y crossfit.
Reservas de clases, gestión de membresías, operación end-to-end.

## Tech stack

- React 18 + TypeScript + Vite
- Tailwind CSS
- Supabase (auth + database + storage + edge functions)
- Netlify (deploy + functions)

## Estado del producto

**v0.1 — Bootstrap** (mayo 2026)

- Forked de EKKO Studio (booking de creator studios para Cravia)
- Schema y features idénticos a EKKO por ahora
- Próximos sprints: branding propio, vocabulario gimnasios, modelo cupos, recurrencia

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
cp .env.example .env.local   # rellena las credenciales de Supabase
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
| `npm run test:e2e` | Playwright (E2E smokes) |
| `npm run supabase:types` | Regenera tipos TypeScript desde la BD |

## Estructura

```
sala-studio/
├── src/
│   ├── shared/           # libs, hooks, utils, types, ui-kit
│   ├── public/           # layout web pública
│   ├── member/           # layout PWA del miembro
│   ├── admin/            # layout admin
│   ├── reception/        # layout recepción (kiosco)
│   └── styles/           # tokens.css, reset.css, sala.css
├── netlify/functions/    # serverless (stripe, qr, admin ops)
├── supabase/migrations/  # schema versionado
├── supabase/seeds/       # data inicial (tenant demo, admin)
├── e2e/                  # Playwright specs
└── docs/                 # decisiones, deployment, runbooks
```

## Convenciones

- **Multi-tenant primero**: cada tabla operativa lleva `tenant_id`; cada query lo filtra.
- **Reglas de negocio en BD**, no en código: usar `tenants.config jsonb` para flags por vertical.
- **Componentes < 500 líneas**: extraer lógica pura a `*Logic.ts` testeable.
- **Toda llamada externa pasa por Netlify Functions** (nunca API keys en cliente).
- **Mobile-first hardening**: `h-dvh`, safe-area-inset, tap targets 44px, anti-zoom iOS.

## Próximos sprints

Ver [SALA_PLAN.md](SALA_PLAN.md) para roadmap completo.

## Repos hermanos

- `ekko-studio`: producto inicial para Cravia (creator studios en Culiacán).

## Ownership

STRYV Studio.
