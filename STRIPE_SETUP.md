# Conectar Stripe — guía paso a paso

Dos flujos de cobro, **misma cuenta Stripe (la de Stryv)**:

| Flujo | Quién cobra | Estado del código |
|---|---|---|
| **1 — SALA → gyms** (tu mensualidad) | SALA es el comercio | ✅ completo, inerte hasta claves |
| **2 — gym → socios** (membresías) | Cada gym = cuenta Connect | 🟡 onboarding listo; falta el cobro al socio |

> Mientras no haya claves, todo responde `stripe_pendiente` (no cobra). El **demo (healthyspace) nunca toca Stripe real** — sigue simulado.

---

## Prerrequisitos
- [x] Migración `20260620260000_flujo1_stripe_ready.sql` (corrida).
- [x] Migración `20260620280000_connect_groundwork.sql` (corrida).

---

## Paso 1 — Activar Connect (modo test)
Dashboard de Stripe (arriba a la izquierda, en **Test mode**) → **Connect** → empezar/activar como **plataforma**. Esto habilita crear cuentas Express para los gyms (Flujo 2).

## Paso 2 — Claves test
Developers → API keys → copiar:
- `sk_test_…` (secret)
- `pk_test_…` (publishable — por ahora no hace falta en el front; el checkout es hospedado)

## Paso 3 — Crear los 9 precios del SaaS
Desde la raíz del repo:
```bash
STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-crear-precios-saas.mjs
```
Crea 3 Products (Starter/Pro/Business) y 9 Prices con sus `lookup_keys`
(`sala_<tier>_<moneda>_mensual`). Es **idempotente**: re-correr no duplica.

## Paso 4 — Webhook del Flujo 1
Developers → Webhooks → **Add endpoint**:
- **URL:** `https://<TU_DOMINIO_NETLIFY>/.netlify/functions/stripe-webhook-saas`
- **Eventos:** `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`
- Crear → copiar el **Signing secret** (`whsec_…`).

## Paso 5 — Variables de entorno en Netlify
Site settings → Environment variables → agregar:
```
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET_SAAS=whsec_xxx   (el del Paso 4)
```
Redeploy (o se aplica en el próximo deploy).

## Paso 6 — Probar el Flujo 1 de punta a punta (test)
1. Entrar como **admin de un tenant real** → **Suscripción** → elegir un plan.
2. Redirige a Stripe Checkout → pagar con tarjeta test `4242 4242 4242 4242`.
3. Volvés a la app → el webhook crea/actualiza `suscripciones_saas` (trial 7 días).
4. Probar **Cancelar** (queda "cancelación programada" + botón Reactivar) y **Reactivar**.

---

## Flujo 2 — pendiente (después del Paso 6)
Con las claves puestas y Connect activo, Claude escribe el último bloque:
- **Cobro al socio** sobre la cuenta conectada del gym (`application_fee`).
- Webhook **`account.updated`** (refresca `charges_enabled` del gym).
- Endpoint webhook nuevo → `STRIPE_WEBHOOK_SECRET_SOCIO` (su propio signing secret).

El botón **"Activar cobros"** (admin → Suscripción → *Cobros a tus socios*) ya
dispara el onboarding Express; solo falta el cobro en sí.

---

## Pasar a producción (live)
Mismos pasos con `sk_live_…` y webhooks en **live**. Los **`lookup_keys` son los
mismos** test→live, así que el código de la app NO cambia. Correr de nuevo el
script del Paso 3 con la `sk_live` para crear los precios en live.

## Cuenta compartida con healthyspaceclub
HSC ya usa esta cuenta. SALA no lo pisa: sus objetos llevan `metadata.app:'sala'`
y los webhooks de SALA ignoran lo que no sea suyo. Mantener los `lookup_keys` de
SALA con prefijo `sala_` (HSC usa `hsc_`).
