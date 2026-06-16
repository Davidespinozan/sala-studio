# Conectar Stripe (membresías del socio)

Todo el flujo de compra/cambio de plan del socio **ya está cableado**. Conectar
Stripe real es completar 3 puntos — sin tocar UI ni la lógica de activación.

## Cómo funciona hoy (sin Stripe)

1. El socio elige un plan en **Perfil → Plan actual y opciones** (`PlanOptionCard`).
2. `iniciarCheckout(tierId)` (`src/shared/lib/checkout.ts`) llama a la function
   **`suscribir-membresia`**.
3. La function:
   - **Tenant demo (`healthyspace`)** → activa con pago simulado vía el RPC
     `activar_suscripcion_socio` → `{ activated: true }`.
   - **Tenant real** → `{ activated: false, reason: 'stripe_pendiente' }` (la UI
     avisa "pago en camino"; no cobra ni activa).
4. La activación REAL (crear/renovar la membresía) vive en **un solo lugar**: el
   RPC `activar_suscripcion_socio(usuario_id, tier_id, stripe_subscription_id,
   stripe_customer_id, periodo_fin)`. Lo llama el backend con `service_role`.

## Los 3 pasos para conectar Stripe

### 1. Env vars (Netlify)
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```
(Ya existen `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.)

### 2. `netlify/functions/suscribir-membresia` → crear Checkout Session
Reemplazar el bloque `[TODO STRIPE]`: en vez de activar/simular, crear una
`stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price:
tier.stripe_price_id, quantity: 1 }], customer: usuarios.stripe_customer_id, ...,
metadata: { usuario_id, tier_id } })` y devolver `{ url: session.url }`.
`iniciarCheckout` ya redirige solo si viene `url`.

### 3. `netlify/functions/stripe-webhook` → activar al pagar
Completar los 2 `[TODO STRIPE]`:
- Verificar firma con `stripe.webhooks.constructEvent`.
- `checkout.session.completed` / `customer.subscription.updated` →
  `activar_suscripcion_socio(usuario_id, tier_id, subscription_id, customer_id,
  current_period_end)` (IDs del `metadata`/objeto).
- `customer.subscription.deleted` → marcar la membresía `cancelada`.

### Datos a cargar
- `tiers.stripe_price_id` por cada plan (columna ya existe).
- Apuntar el endpoint del webhook en el dashboard de Stripe a
  `/.netlify/functions/stripe-webhook`.

## Quitar el pago simulado del demo (opcional)
En `suscribir-membresia`, el gate `esDemo` activa sin cobro. Una vez que Stripe
esté en producción, podés dejar que el demo también pase por Checkout (test mode)
o mantener el atajo simulado para que el visitante no tenga que pagar.
