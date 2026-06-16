# Tests end-to-end (Playwright)

## Estado

- **Fase 1 — read-only (HECHA).** `e2e/tests/smoke-landing.spec.ts`. No requiere
  login ni muta datos. Corre contra el tenant que carga en localhost (healthyspace).
  Cubre: render de la landing + marca del tenant, cero errores de consola
  (atrapa crashes tipo ErrorBoundary), sin desborde horizontal en mobile, `/login`,
  y ruta desconocida.
  ```bash
  npm run test:e2e -- --project=chromium      # webkit: npx playwright install webkit
  ```

- **Fase 2 — flujos con login (PENDIENTE).** reservar, check-in (recepción),
  comprar/cambiar plan, reportes admin. Requieren sesión y **mutan datos**, así
  que NO deben correr contra producción. Necesitan una **Supabase de staging**.

---

## Runbook: montar staging para la Fase 2

> Objetivo: una base aislada, igual a prod, con cuentas de test conocidas, para
> e2e que crean/cancelan reservas sin tocar datos reales.

### 1. Crear el proyecto de staging (David)
- Nuevo proyecto Supabase **gratis** (ej. `sala-staging`).
- Activar **Allow anonymous sign-ins** (Auth → Providers) — igual que prod, para
  el flujo demo.

### 2. Aplicar el esquema
- Correr **todas** las migraciones de `supabase/migrations/` en orden, en el SQL
  Editor del proyecto staging (mismo workflow que prod: nada de `supabase db push`).
- Correr los seeds de demo (lotes `20260616150000`..`20260616200000`) para tener
  un tenant `healthyspace` con datos.

### 3. Cuentas de test (David, en staging)
Crear 3 cuentas con credenciales fijas (NO reutilizar prod):
- `e2e-admin@staging.test`  (rol admin)
- `e2e-socio@staging.test`  (rol miembro, con membresía activa)
- `e2e-recepcion@staging.test` (rol recepcionista)

### 4. Variables de entorno (NO commitear)
`.env.e2e` local + secrets en CI:
```
VITE_SUPABASE_URL=https://<staging-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<staging anon key>
E2E_ADMIN_EMAIL=e2e-admin@staging.test
E2E_ADMIN_PASSWORD=...
E2E_SOCIO_EMAIL=e2e-socio@staging.test
E2E_SOCIO_PASSWORD=...
E2E_RECEPCION_EMAIL=e2e-recepcion@staging.test
E2E_RECEPCION_PASSWORD=...
```
Correr e2e apuntando a staging:
```bash
env $(cat .env.e2e | xargs) npm run test:e2e
```

### 5. Lo que construyo yo una vez exista staging
- `e2e/helpers/auth.ts` — login programático por rol (lee las env vars).
- `e2e/fixtures/` — fixtures por rol (admin/socio/recepción).
- Specs Fase 2:
  - **socio**: reservar una clase → aparece en "mis reservas" → cancelar.
  - **recepción**: check-in de una reserva por QR/lista.
  - **socio**: comprar/cambiar plan (flujo de `suscribir-membresia`).
  - **admin**: dashboard y reportes cargan con datos.
- Cada spec **limpia lo que crea** (cancela la reserva, etc.) o se apoya en el
  reset nocturno del demo.

---

## Por qué no e2e con login contra prod
Cada corrida crearía reservas/membresías reales y ensuciaría reportes y agenda de
gimnasios reales. El reset nocturno solo limpia el tenant demo, no el resto. Staging
aísla el riesgo y permite credenciales fijas sin exponer cuentas reales.
