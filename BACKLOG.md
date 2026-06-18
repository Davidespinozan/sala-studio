# Backlog — SALA Studio

Lista viva de pendientes. Marcá `[x]` lo hecho. Orden = prioridad sugerida.

---

## 0. Por commitear / desplegar (inmediato)
- [ ] Tanda hardening: `npm audit fix` (parchó `ws` high), 7 stubs muertos borrados, fix de `Dashboard` (dep por id).
- [ ] Tanda plug-and-play: marcadores `TODO STRIPE` + sección de touchpoints en `STRIPE.md`.

> Todo verde: tsc, lint (0 warnings), 156 tests, build, 4 e2e.

---

## 1. Stripe — AL FINAL (ya está plug-and-play)
Conectar = seguir `STRIPE.md` + `grep -rn "TODO STRIPE"`. No requiere UI ni lógica nueva.
- [ ] Env vars en Netlify: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- [ ] `suscribir-membresia` → crear Checkout Session (reemplazar bloque `[TODO STRIPE]`).
- [ ] `stripe-webhook` → verificar firma + activar/cancelar vía `activar_suscripcion_socio`.
- [ ] Cargar `tiers.stripe_price_id` por plan.
- [ ] Touchpoints que se "encienden": Método de pago (guardar tarjeta), Historial de pagos, `MembresiaPendiente` (auto-pago sin recepción).

---

## 2. Testing / calidad
- [ ] **Staging Supabase** (David): proyecto aparte + migraciones + seeds + cuentas de test. Ver `E2E.md`.
- [ ] **e2e Fase 2** (yo, una vez exista staging): reservar→cancelar, check-in, comprar plan, reportes admin.
- [ ] (opcional) `npx playwright install webkit` para correr el proyecto mobile-safari.

---

## 3. Estrategia vs CyclingBoost (igualar nicho + explotar debilidades)
> Ninguno de Tier 0-3 depende de Stripe (respeta "Stripe al final"). Orden = impacto/esfuerzo.

### Tier 0 — Landing que VENDE (máxima prioridad: es lo único que nos gana CyclingBoost)
- [ ] **Mockups/screenshots REALES en la landing** (hoy: 5 placeholders grises). Ventaja: ya hay demo sembrado (healthyspace) → capturar pantallas reales con Playwright (admin dashboard, reservar, check-in QR, agenda, reportes) y cablearlas en el showcase. *Lo #1 que mueve la aguja.*
- [ ] **Botón flotante de WhatsApp** en toda la landing (canal real en LATAM). Requiere: número + texto pre-poblado.
- [ ] **Form inline de contacto** antes del footer (Nombre + Email + **Instagram del estudio** + WhatsApp + Enviar). Requiere: destino (email/tabla/función).
- [ ] **Decisión de motion**: self-serve (registro→trial→pago) vs sales-led (CTA "Agendá demo"). Define el CTA principal y si el pricing va público. *Decisión de David.*

### Tier 1 — Quick wins comerciales (días)
- [ ] **Trial a 14 días sin tarjeta**: subir `TRIAL_DIAS` y alinear el RPC de onboarding (hoy hardcodea 7 días). *Pricing público ya existe ✅.*
- [ ] **Soporte SALA por WhatsApp** en el panel admin (botón directo dueño→soporte). Retención. *No existe (el WhatsApp actual es tenant→sus socios).*

### Tier 2 — Diferenciador de producto (el corazón del plan)
- [ ] **Creador de Mapa de Salón dinámico** (drag-and-drop): el admin diseña el salón con iconos según disciplina (bici / mat / reformer). + **selección de lugar al reservar** (socio elige su spot). *No depende de Stripe. EL feature.*
- [ ] **Módulo de Asignación de Accesorios** (genérico): tallas de zapatillas (spinning), guantes (boxeo), mats/bloques (yoga). Supera al "Shoe Manager" por ser multidisciplina.

### Tier 3 — Adquisición / canales
- [ ] **Migración en 1 clic**: importar socios/membresías/créditos desde CSV/otro software. Gancho comercial ("migramos gratis en 24h"). *No existe.*
- [ ] **Widgets de reserva embebibles** (WordPress/Wix/Squarespace), estéticos, dark/boutique, rápidos. (Hoy hay landing por tenant, no widget externo.)

### Tier 4 — Grande / nativo (Enterprise)
- [ ] **Branded App de marca blanca** (iOS/Android compilada con logo+colores del cliente). Plan Enterprise / pago de setup. (Hoy es PWA.)
- [ ] **Métricas de rendimiento** (HealthKit / Google Health Connect: calorías, ritmo cardíaco post-clase). *Acoplado a la app nativa.*

### Otros features (de la lista previa, post-Stripe en su mayoría)
- [ ] POS de productos en recepción · paquetes/drop-ins · cupones · referidos/gift cards. *Dependen de Stripe.*
- [ ] Marketing email/SMS · nómina de instructores.

---

## 4. Deuda técnica (diferida, hacer con red de tests)
- [ ] Refactor de archivos grandes (DESPUÉS de e2e Fase 2): `Landing.tsx` (1177), `ClaseDetalle.tsx` (1136), `Reportes.tsx` (1132), `AjustesLanding.tsx` (1048), `Reservar.tsx` (507).
- [ ] Utilidades CSS para ~170 estilos inline duplicados (`.ek-flex`, etc.).
- [ ] Constantes de rutas (`routes.ts`) en vez de paths hardcodeados.
- [ ] **Upgrade mayor de Vite** (3 vulns restantes del `npm audit`, requieren cambios breaking — probar con calma).

---

## Hecho esta semana (referencia)
- Demo migrado a `healthyspace` (sala-demo borrado), apex con marca SALA fija.
- Demo pulido: 4 vistas, 2 sedes pobladas, ~1.6k reservas, MRR ~$35k.
- Compra de membresía **cableada** para Stripe (RPC + functions + UI + `STRIPE.md`).
- Hardening post-auditoría (slug real, dashboards sin loading eterno, stubs borrados).
- e2e Fase 1 (read-only) + runbook de staging (`E2E.md`).
