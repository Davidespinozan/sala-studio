# Pendientes por traer de ekko

ekko (`/Users/davidespinoza/ekko-studio`, repo `Davidespinozan/ekko-studio`) es el repo hermano: mismo stack, renta de estudios de grabación, single-tenant. Aquí va lo que ekko ya resolvió y a SALA le sirve.

**No es copiar y pegar.** Hay que tomar el **diseño** y re-implementarlo sobre el modelo de SALA:
- clases virtuales (`expandir_clases`);
- `pagos` append-only;
- `membresia_movimientos`;
- multi-tenant y multi-sucursal;
- `_audrec_log`.

**Cómo usarlo:** "lee docs/DE_EKKO.md y empecemos por el punto N". Al terminar, cambiar el estado a `hecho (<commit>)`.

Estados: `pendiente` · `en curso` · `hecho (<commit>)` · `descartado (motivo)`

Origen: comparación SALA vs ekko del 2026-10-07.

---

## 1. Reprogramar reserva (un solo paso) — `pendiente`
**En ekko:** RPC `reprogramar_reserva`. Mueve la reserva a otro slot de forma atómica, junto con sus invitados y extras pagados, y manda un solo aviso al socio. Queda auditado.

**En SALA hoy:** hay que cancelar y volver a reservar. Eso puede perder el crédito si ya pasó la ventana de cancelación; desde 4c798b9 solo se protege si es la *misma* clase.

**Ver en ekko:**
- RPC `reprogramar_reserva` en `supabase/migrations`
- `src/reception/pages/PerfilMiembroRecepcion.tsx`

**Adaptar:**
- Cupo y mapa de lugares de la clase destino.
- Lock advisory `clase_lugares:<id>`.
- Orden de locks R → X → M.
- Lista de espera de la clase origen.

## 2. Página "Operación" (salud de Stripe y procesos) — `pendiente`
**En ekko:**
- Vista `v_pendientes_operativos` que junta:
  - eventos de Stripe atorados;
  - operaciones de cobro fallidas;
  - divergencias de membresía (activa sin derecho, varias vivas a la vez, Stripe contradice el estado local);
  - discrepancias de la conciliación diaria;
  - push y correos no entregados.
- Cada caso tiene una acción con nota obligatoria.
- Cron `cron-reconciliar-stripe` que solo detecta, sin reparar.

**En SALA hoy:**
- `stripe_salud_operador` (solo lectura, en Cobros).
- `reconciliar-stripe` manual.
- `stripe_replay_event` sin interfaz.

**Ver en ekko:**
- `src/admin/pages/Operacion.tsx`, `hooks/useOperacion.ts`
- RPCs `resolver_evento_stripe`, `revisar_discrepancia_stripe`, `staff_reintentar_operacion_cobro`
- Relacionado: "Revisiones financieras" en `src/admin/components/cobros/RevisionesFinancieras.tsx` (disputas y devoluciones de origen desconocido; documentan el caso, no mueven saldo)

**Contexto:** cubre varios P1 de la Auditoría Master #2 (Stripe sin dead-letter).

## 3. Sala fuera de servicio — `pendiente`
**En ekko:** marcar un recurso fuera de servicio con motivo. Cancela automáticamente las reservas futuras y avisa a los socios.

**Ver en ekko:**
- Netlify Function `reception-recurso-servicio`
- Trigger `reservas_bloquear_recurso_fuera_servicio`
- `src/shared/components/EstudiosServicioModal.tsx`

**Adaptar:**
- En SALA son **clases**: usar `cancelar_clase` por rango y devolver créditos con el ledger.
- Regla #1: no perder reservas sin devolución ni aviso.
- Ya estaba en el backlog como "recurso fuera de servicio temporal".

## 4. Cobro con tarjeta (Stripe) en el mostrador — `pendiente`
**En ekko:** al asignar un plan, opción "Tarjeta por Stripe": el socio teclea la tarjeta en el dispositivo del staff (Stripe Elements). El webhook activa el plan y la interfaz solo observa.

**Ver en ekko:**
- Netlify Function `mostrador-crear-pago`
- `src/shared/components/membresia/AsignarPlanModal.tsx`

**Adaptar:**
- Va sobre la cuenta Connect del gym.
- El pago debe entrar a `pagos` con método `stripe`.
- Usar la idempotencia de SALA (`_op_begin` / `_op_finish`).

## 5. Correo transaccional (Resend) — `pendiente`
**En ekko:** `netlify/functions/_lib/email.ts` y el cron `cron-email` (cada 2 minutos). Si no hay `RESEND_API_KEY`, no hace nada. Cubre confirmación y cancelación de reserva, entre otros.

**Contexto SALA:** se lanzó sin correos a propósito. Ver la memoria "Plan de correos" (remitente, spam, cuenta de Stripe compartida). Esto da la plomería ya hecha; falta la decisión de remitente.

## 6. "Miembros en riesgo" con WhatsApp — `pendiente`
**En ekko:** cada fila de la lista de miembros en riesgo tiene un link `wa.me` con un mensaje ya escrito (o correo si no hay teléfono).

**En SALA hoy:** Reportes tiene el top 10 en riesgo, pero sin acción.

**Ver en ekko:** `src/admin/pages/Reportes.tsx` (bloque Engagement)

**Tamaño:** cambio chico de UI.

## 7. Ficha de identidad que bloquea el check-in — `pendiente` (requiere decisión)
**En ekko:** INE (folio y foto en un bucket privado) más contrato firmado; si la ficha está incompleta, se bloquea el check-in.

**Contexto SALA:** se decidió "sin INE a propósito" para invitados. Para socios es una decisión de David; se podría hacer opcional por gym.

## Otros (menores)
- **Pagar invitados extra dentro de la app** (`crear-pago-invitados`). Ya estaba en el backlog.
- **Máximo de sesiones por día global del gym** (`reserva.max_sesiones_por_dia`). SALA lo tiene por plan (`max_reservas_dia`), y probablemente basta.
- **Reactivar staff revocado:** ekko tampoco lo tiene en la interfaz.

---

## Pendientes de SALA detectados en la misma revisión
- pg_cron `regenerar-clases-nightly` puede seguir registrado y fallando: llama a una Edge Function que ya no existe (ver `20260613001800_clases_c1_baja_generacion.sql`). Desprogramarlo en Supabase.
- El límite de socios por plan SaaS (200 / 600) no se aplica, y las features Pro no tienen candado.
- La ficha del socio en admin no tiene pausar, salud, huella ni movimientos del plan; solo están en recepción.
- `fake-signup` (mock legacy) sigue referenciado desde `src/public/pages/Signup.tsx` y `src/admin/lib/crudHelpers.ts`.
