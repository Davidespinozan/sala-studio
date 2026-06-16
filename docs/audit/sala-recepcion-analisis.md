# Análisis del módulo de Recepción — SALA Studio

> **Propósito:** descripción factual y exhaustiva del módulo de Recepción de SALA
> en el estado actual del código, para comparar contra un módulo equivalente y
> detectar GAPS. NO es una crítica ni una propuesta — es un retrato del HEAD.
>
> **Rama / HEAD analizado:** `main` @ `6107f3d` (*fix(branding): zona-logo =
> barra-botones*). El prompt de esta auditoría asumía `0063121` como HEAD, pero
> después de ese commit se sumó `6107f3d`, que toca `src/styles/sala.css`
> (fondo del header de miembro + topbar mobile compartido). Ese cambio afecta la
> superficie visual de Recepción, así que se refleja acá.
>
> **Perímetro:** estrictamente `src/reception/**` + los archivos/RPCs/tablas que
> Recepción consume. Componentes compartidos (AppShell, AppSidebar) se mencionan
> pero no se describe su markup interno.
>
> **Contexto:** Recepción está en mitad de un rediseño total planeado en 5
> sub-rounds; sólo Sub-round 1 está parcialmente entregado. Lo que sigue es
> genuinamente corto comparado con un módulo terminado. Eso ES el dato.

---

## 1. INVENTARIO DE ARCHIVOS

`src/reception/` contiene **12 archivos** (uno de ellos `.gitkeep`). Genuinamente
chico.

| Path | Líneas | Qué hace |
|---|---|---|
| [src/reception/ReceptionLayout.tsx](../../src/reception/ReceptionLayout.tsx) | 66 | Layout raíz de `/recepcion`. Guard de rol, define la nav (`RECEPCION_SECTIONS`, plana, 2 destinos), envuelve todo en `AppShell` + `AppSidebar` (compartidos, post-Pieza 1) y declara las `<Routes>`. Incluye la ruta TEMP-PREVIEW. |
| [src/reception/pages/Scanner.tsx](../../src/reception/pages/Scanner.tsx) | 183 | Pantalla "Hoy" (default `/recepcion`). Header propio `.ek-header-glass`, monta `ReservasHoyView`, el FAB de cámara, el `CameraModal`, el overlay `CheckInDetail`, y conecta el scanner HID. Orquesta el check-in por QR. |
| [src/reception/pages/Socios.tsx](../../src/reception/pages/Socios.tsx) | 155 | Buscador de socios (`/recepcion/socios`). Header propio, input de búsqueda con debounce, lista de `SocioRow` (link a la ficha). Read-only. |
| [src/reception/pages/SocioFicha.tsx](../../src/reception/pages/SocioFicha.tsx) | 362 | Ficha read-only de un socio (`/recepcion/socios/:id`). Hero + alerta contextual + tarjetas membresía/reservas/asistencia/notas. Exporta `default SocioFicha` (con header) y `export function Ficha` (sólo el cuerpo, reutilizado por el preview). |
| [src/reception/pages/SocioFichaPreview.tsx](../../src/reception/pages/SocioFichaPreview.tsx) | 99 | **TEMP** — renderiza `<Ficha>` con 6 datos mock (Activa / Activa-vence-pronto / Pausada / Vencida / Sin plan / Bloqueado) en fila horizontal. Marcado "se borra antes del commit final del Sub-round 1". |
| [src/reception/components/ReservasHoyView.tsx](../../src/reception/components/ReservasHoyView.tsx) | 464 | Vista de reservas del día con selector de día (±1), secciones "Llegando ahora" / "Resto del día", `ReservaCard`, y el `ManualCheckInModal` (check-in manual con motivo opcional). |
| [src/reception/components/CheckInDetail.tsx](../../src/reception/components/CheckInDetail.tsx) | 173 | Overlay de resultado de check-in (éxito o error). Muestra ficha del miembro + datos de la reserva + stats. Auto-cierra a los 15s con cuenta regresiva visible. |
| [src/reception/components/CameraModal.tsx](../../src/reception/components/CameraModal.tsx) | 91 | Modal de cámara con `@zxing/browser` (`BrowserMultiFormatReader`). Pide cámara trasera, decodifica QR en vivo con cooldown de 1.5s, maneja error de cámara. |
| [src/reception/hooks/useReservasHoy.ts](../../src/reception/hooks/useReservasHoy.ts) | 82 | Hook de reservas de un día (join recurso + usuario), polling cada 30s. Exporta `checkInManual()` (llama RPC `check_in_manual_atomic` + traduce errores). |
| [src/reception/hooks/useSocios.ts](../../src/reception/hooks/useSocios.ts) | 61 | Buscador de socios read-only. Query debounced (220ms) sobre `usuarios` (`rol='miembro'`), filtro `.or()` nombre/teléfono/email, límite 30. |
| [src/reception/hooks/useSocioFicha.ts](../../src/reception/hooks/useSocioFicha.ts) | 195 | Carga la ficha completa de un socio: usuario + membresía(+tier) + próximas reservas + asistencia (semana/mes/%). Mapea `membresias.status` a 4 estados visuales. |
| [src/reception/hooks/useScannerHID.ts](../../src/reception/hooks/useScannerHID.ts) | 62 | Listener global de teclado para scanner USB/HID. Heurística: ≥15 chars en <500ms terminados en Enter = scan. Se pausa con modales abiertos. |
| `src/reception/components/.gitkeep` | 0 | Placeholder de carpeta. |

**Observación:** no hay archivos de tipos compartidos propios (los tipos viven
inline en cada hook), no hay tests en `src/reception/**`, no hay barrel/index.

---

## 2. ARQUITECTURA DE RUTAS

Definidas en [ReceptionLayout.tsx:52-56](../../src/reception/ReceptionLayout.tsx#L52).
Todas montan bajo el prefijo `/recepcion` (definido en el router raíz, fuera de
este perímetro).

| Path (relativo) | Path completo | Componente | Permiso | Temporal |
|---|---|---|---|---|
| `/` | `/recepcion` | `Scanner` (lazy) | rol ∈ {recepcionista, admin} | no |
| `/socios` | `/recepcion/socios` | `Socios` (lazy) | rol ∈ {recepcionista, admin} | no |
| `/socios/_preview` | `/recepcion/socios/_preview` | `SocioFichaPreview` (lazy) | rol ∈ {recepcionista, admin} | **SÍ — TEMP** |
| `/socios/:id` | `/recepcion/socios/:id` | `SocioFicha` (lazy) | rol ∈ {recepcionista, admin} | no |

- El guard de permiso NO está por-ruta: es único, en el cuerpo de
  `ReceptionLayout` (sección 6). Todas las rutas heredan el mismo gate.
- `/socios/_preview` está deliberadamente **antes** de `/socios/:id` para que el
  segmento estático gane sobre el dinámico. Marcada con comentario
  `TEMP-PREVIEW · se borra antes del commit final del Sub-round 1`
  ([ReceptionLayout.tsx:13,57](../../src/reception/ReceptionLayout.tsx#L13)).
- No hay ruta de alta de socio, gestión de membresía, ni cancelación de reserva.

---

## 3. PANTALLAS — UNA POR UNA

### Nota transversal de lenguaje visual (importante para la comparación)

La Pieza 1 del rediseño elevó **sólo el shell externo**: `AppShell` (sidebar
oscuro teñido en desktop + topbar mobile + drawer) y `AppSidebar`. **Las
pantallas internas NO fueron elevadas**: cada página sigue renderizando su
**propio header `.ek-header-glass`** y usa estilos inline + clases del lenguaje
viejo (`.rec-*`). Resultado: hay **doble cabecera** — la del `AppShell` (logo +
"RECEPCIÓN" + hamburguesa/sidebar) y la `.ek-header-glass` interna de cada
página (logo + "RECEPCIÓN" + "Salir"). El "nivel admin" (sidebar oscuro,
`.ek-card` con sombras teñidas, `.ek-eyebrow` + título display) está sólo en el
contorno; el contenido sigue en el lenguaje previo.

---

### 3.1 Scanner — "Hoy" (`/recepcion`)

**a) Layout visual** — [Scanner.tsx](../../src/reception/pages/Scanner.tsx)
- Contenedor `.rec-shell`.
- Header propio `.ek-header-glass` con eyebrow "RECEPCIÓN" (mustard), `TenantLogo`,
  nombre del usuario y botón **"Salir"** (`signOut`). *(Lenguaje viejo; duplica
  el rol/logo del AppShell.)*
- `.rec-main` con `<ReservasHoyView>` + `<PoweredBySala>`.
- **FAB de cámara**: botón circular fijo abajo-derecha (64px), fondo
  `--ek-mustard`, ícono de cámara, sombra teñida con `--sala-primary-glow`, hover
  con scale. ([Scanner.tsx:109-156](../../src/reception/pages/Scanner.tsx#L109)).
- Overlay `CheckInDetail` sobre `.rec-detail-backdrop` cuando hay resultado.
- `CameraModal` cuando `cameraOpen`.

**b) Datos que muestra** — delegados a `ReservasHoyView` (3.1b-bis) y a
`CheckInDetail` (3.4). El header muestra `usuario.nombre`/`email` del `useAuth`.

**c) Acciones**
- **Escanear QR (HID)**: `useScannerHID` escucha teclado global (activo sólo si
  no hay overlay/cámara abiertos). Al detectar scan → `backendPost('qr-verify')`.
- **Abrir cámara**: FAB → `CameraModal` → al decodificar QR → `qr-verify`.
- **"Salir"**: cierra sesión.
- Tras `qr-verify`: si `success` → `CheckInDetail` de éxito; si no → de error.
  Refresca la lista (`refreshTick`). NO pide motivo ni confirma. NO registra en
  bitácora.

**d) Estados especiales**
- Loading: `ReservasHoyView` muestra "Cargando agenda…".
- Error de QR: `CheckInDetail` variante error con mensaje traducido.
- Error de red en `qr-verify`: capturado en try/catch → `CheckInDetail` error con
  el mensaje de la excepción ([Scanner.tsx:53-55](../../src/reception/pages/Scanner.tsx#L53)).

**e) Desktop vs mobile**: el FAB y el layout son idénticos; la diferencia
desktop/mobile la aporta el `AppShell` (sidebar vs topbar+drawer). Scanner en sí
no tiene breakpoints propios.

#### 3.1b-bis `ReservasHoyView` (montado dentro de Scanner)

**a) Layout**
- Selector de día: flechas ◀ ▶ (±1 día) + etiqueta "VISTA DEL DÍA" + fecha
  formateada ("Hoy"/"Mañana"/"Ayer"/fecha larga es-MX). Estilos inline.
- Sección **"LLEGANDO AHORA"** (eyebrow mustard): reservas dentro de la ventana
  (ver lógica abajo). Empty: "No hay reservas próximas a llegar."
- Sección **"RESTO DEL DÍA"** / "RESERVAS DEL DÍA": resto de reservas. Empty con
  ícono `CalendarClock` + texto contextual (hoy vs otro día).
- `ReservaCard` por reserva (`.ek-card .ek-card-interactive` + inline). Modal
  `ManualCheckInModal` al seleccionar.

**b) Datos** — `useReservasHoy(fecha)`:
- Tabla `reservas` del tenant, `slot_inicio` dentro del día elegido, ordenadas por
  hora; join `recurso:recursos(id,slug,nombre)` y
  `usuario:usuarios(id,nombre,email,membresia_tier)`
  ([useReservasHoy.ts:32-38](../../src/reception/hooks/useReservasHoy.ts#L32)).
- Polling cada 30s (no visibility-aware).
- Por card: hora (`slot_inicio`), nombre del socio (capitalizado) o email,
  `recurso.nombre`, `membresia_tier`, badge de status
  (confirmada→"PENDIENTE" / completada→"OK" / cancelada / no_show).
- "Llegando ahora" (sólo si la fecha vista es hoy): `now` entre
  `slot_inicio−15min` y `slot_fin`, o cerca del inicio ±15min
  ([ReservasHoyView.tsx:57-76](../../src/reception/components/ReservasHoyView.tsx#L57)).

**c) Acciones**
- Tap en card (deshabilitada si cancelada/no_show) → `ManualCheckInModal`.
- **Check-in manual** ([ManualCheckInModal](../../src/reception/components/ReservasHoyView.tsx#L347)):
  campo **"MOTIVO (OPCIONAL)"** + botones Cancelar / "Marcar check-in" →
  `checkInManual(reserva.id, motivo)` → RPC `check_in_manual_atomic`. Si la
  reserva ya está `completada`, el modal muestra "Ya hizo check-in (método)" sin
  permitir re-check-in. Pesimista (espera el RPC, luego `refetch`). NO registra
  en bitácora. Motivo **opcional**, no obligatorio.

**d) Estados**: loading "Cargando agenda…"; empties contextuales; error del RPC
traducido y mostrado dentro del modal
([ReservasHoyView.tsx:435-439](../../src/reception/components/ReservasHoyView.tsx#L435)).
Error de la query de lista: sólo `console.error`, sin UI de error (la lista queda
vacía silenciosamente) ([useReservasHoy.ts:40-44](../../src/reception/hooks/useReservasHoy.ts#L40)).

---

### 3.2 Socios — buscador (`/recepcion/socios`)

**a) Layout** — [Socios.tsx](../../src/reception/pages/Socios.tsx)
- `.ek-page` + header propio `.ek-header-glass` (igual que Scanner: eyebrow
  "RECEPCIÓN", logo, nombre, botón "Salir").
- Eyebrow "SOCIOS" + input de búsqueda con ícono lupa (`autoFocus`).
- Lista de `SocioRow` (avatar/iniciales + nombre + teléfono/email + chevron),
  cada uno `Link` a `/recepcion/socios/:id`.

**b) Datos** — `useSocios(query)`:
- Tabla `usuarios`, `rol='miembro'`, campos
  `id,nombre,email,telefono,avatar_url,membresia_tier,status`, orden por nombre,
  límite 30. Con query: `.or(nombre/telefono/email ilike)`. Debounce 220ms.
  Sanitiza `,()*` del input.

**c) Acciones**: sólo **navegar** a la ficha. No hay alta, edición, ni acciones
sobre el socio desde acá. Read-only.

**d) Estados**: loading = 4 skeletons; empty diferenciado (con query → "Sin
resultados"; sin query → "Sin socios todavía"); error → `console.error` + lista
vacía (sin UI de error).

**e) Desktop vs mobile**: contenedor `maxWidth: 640px` centrado; sin más
diferencias propias.

---

### 3.3 SocioFicha — ficha read-only (`/recepcion/socios/:id`)

**a) Layout** — [SocioFicha.tsx](../../src/reception/pages/SocioFicha.tsx)
- `.ek-page` + header propio `.ek-header-glass` con botón ⬅ (volver a socios) +
  "Socios · Ficha".
- Cuerpo `maxWidth: 460px`. Render de `<Ficha>`:
  - **HERO** oscuro (`--grad-immersive`): avatar/iniciales, nombre, teléfono·email,
    badge de estado con color **semántico** (D-021: activa→success,
    pausada→warning, vencida→error, sin_plan→neutro).
  - **ALERTA contextual** (`FichaAlerta`): prioridad bloqueo > vencida > pausada >
    sin_plan > "vence pronto" (≤5 días). Colores semánticos fijos.
  - **Tarjeta MEMBRESÍA** (`.ek-card`): estado, vence/venció/plan, créditos
    (con sufijo "restantes"/"congelados"/"—"/"Ilimitado" según tipo y estado),
    tipo de plan. Badge de tier.
  - **PRÓXIMAS RESERVAS** (`.ek-card`): hasta 5, con día/hora + recurso + badge
    "Confirmada". Empty contextual por estado.
  - **ASISTENCIA** (`.ek-card`): contadores semana / mes / % asistencia.
  - **NOTAS SOBRE EL SOCIO** (`.ek-card`): `usuarios.notas_admin`, read-only.
- Esta pantalla usa parcialmente el lenguaje nuevo (`.ek-card`, `.ek-eyebrow`,
  hero `--grad-immersive`), pero sigue dentro de su propio `.ek-header-glass`.

**b) Datos** — `useSocioFicha(id)` (4 grupos de queries):
1. `usuarios` (id, nombre, email, telefono, avatar_url, status,
   `bloqueado_hasta`, `notas_admin`).
2. `membresias` más reciente + `tier:tiers(nombre,tipo)` — **ver GAP de RLS en
   sección 6**. Mapea `status` → estado visual
   ([useSocioFicha.ts:62-68](../../src/reception/hooks/useSocioFicha.ts#L62)).
3. Próximas reservas confirmadas (≤5) + `recurso:recursos(nombre)`.
4. Asistencia: 4 counts en paralelo (completadas semana/mes/total + no_shows);
   `pct = completadas / (completadas + no_shows)`.

**c) Acciones**: **ninguna**. Read-only total. No hay botón de renovar, recargar,
congelar, bloquear, editar contacto, ni agregar nota. Sólo "Volver a socios".

**d) Estados**: loading = `FichaSkeleton` (3 bloques); error → texto +
"Volver a socios"; socio inexistente → "No encontramos ese socio.".

**e) Desktop vs mobile**: `maxWidth: 460px`; sin breakpoints propios.

---

### 3.4 CheckInDetail (overlay, montado por Scanner)

- **Éxito**: eyebrow "CHECK-IN OK" + avatar/nombre/contacto + grilla (SALA, HORA,
  DURACIÓN, FOLIO mono, PERSONAS) + grilla (MEMBRESÍA pro/básica/sin plan,
  CHECK-IN HOY, CHECK-IN SEMANA) + notas del miembro si existen. Botón "Listo".
- **Error**: eyebrow "NO PUEDE ENTRAR" + mensaje + "Si necesitás anular o
  aclarar, avisá a admin." + "Entendido".
- **Auto-cierre a 15s** con cuenta regresiva visible ("Cierra en Ns")
  ([CheckInDetail.tsx:43-57](../../src/reception/components/CheckInDetail.tsx#L43)) —
  patrón kiosco.
- Datos vienen de la respuesta de `qr-verify`/`check_in_atomic` o del
  `check_in_manual_atomic` (mismo shape `{miembro, recurso, reserva, stats}`).

### 3.5 SocioFichaPreview (TEMP)

- Renderiza `<Ficha>` con 6 mocks en fila horizontal, con banner "PREVIEW
  INTERNO · TEMPORAL". Sólo validación visual; sin datos reales ni acciones.
  **Pendiente de borrar** antes del cierre del Sub-round 1.

---

## 4. FLUJOS COMPLETOS (END-TO-END)

### Flujos que HOY se completan de principio a fin

**F1 — Check-in por QR (scanner HID).**
1. Recepcionista en `/recepcion` (Scanner). 2. Socio muestra su QR; el lector USB
"tipea" el payload + Enter. 3. `useScannerHID` lo detecta → `qr-verify` (Netlify)
→ valida JWT + llama `check_in_atomic`. 4. `CheckInDetail` de éxito/error;
auto-cierra a 15s. **Clics del recepcionista: 0** (automático). Puede fallar en:
QR inválido/expirado, reserva cancelada/no_show, ya-check-in, fuera de ventana,
error de red.

**F2 — Check-in por QR (cámara).** Igual que F1 pero: tap en FAB → permiso de
cámara → apuntar al QR → `@zxing` decodifica → `qr-verify`. **Clics: ~1** + dar
permiso de cámara. Puede fallar además por cámara denegada/inexistente.

**F3 — Check-in manual desde la lista del día.**
1. `/recepcion` → ubicar la reserva en "Llegando ahora"/"Resto del día". 2. Tap
en la card → `ManualCheckInModal`. 3. (Opcional) escribir motivo. 4. "Marcar
check-in" → `check_in_manual_atomic`. 5. Lista se refresca; cierra modal.
**Clics: ~2-3.** Puede fallar por: fuera de ventana (−30min/+60min),
cancelada/no_show, ya-check-in, no autorizado.

**F4 — Buscar socio y ver su ficha (read-only).**
1. `/recepcion/socios`. 2. Escribir nombre/teléfono. 3. Tap en el resultado →
`/recepcion/socios/:id`. 4. Ver hero, alerta, membresía, reservas, asistencia,
notas. **Clics: ~2.** Límite: **acá termina** — no hay ninguna acción posible
sobre el socio. (Además, para un recepcionista puro la membresía puede venir
vacía por el gap de RLS — sección 6.)

### Flujos PARCIALES / con límite duro

- **Gestión de socio desde la ficha:** ver F4 — es un cul-de-sac de sólo lectura.
- **Cambiar de día en la agenda:** funciona con flechas ±1, pero no hay date
  picker ni salto a "hoy" desde otro día (sólo ◀▶).

### Flujos PLANEADOS pero NO IMPLEMENTADOS (declarados en comentarios/tabla)

> Fuente: comentarios en la migración de auditoría + el enum `accion` de
> `auditoria_recepcion`, que enumera el vocabulario de acciones futuras. No hay
> doc formal de los Sub-rounds 2-5 en `docs/` (sólo `docs/DECISIONS.md`, que no
> los detalla).

El enum de acciones declara estos verbos, **ninguno implementado en UI hoy**:
- Membresía: `renovar`, `cambiar_plan`, `recargar_creditos`, `congelar`,
  `reactivar`, `cancelar`.
- Reserva: `crear`, `cancelar`, `lista_espera_anotar`, `lista_espera_promover`.
- Socio: `crear`, `editar_contacto`, `reset_password`, `bloquear`,
  `desbloquear`, `nota`.
- Clase: `crear`, `cancelar`, `reasignar_coach`, `marcar_asistencia`,
  `marcar_no_show`.
- Pago: `reenviar_link`, `activar`.
- Check-in: `manual`, `qr` (estos dos SÍ ocurren en UI, pero **no escriben** la
  bitácora todavía).

---

## 5. BACKEND / RPCs QUE RECEPCIÓN USA

### Llamados HOY desde `src/reception/**`

| Endpoint | Tipo | Params | Qué hace | Gate | Escribe `auditoria_recepcion` |
|---|---|---|---|---|---|
| `check_in_manual_atomic` | RPC SECURITY DEFINER | `p_reserva_id uuid`, `p_motivo text=NULL` | Marca la reserva `completada`, setea `check_in_at/by`, `check_in_method='manual'`, agrega motivo a `notas`; devuelve `{miembro, recurso, reserva, stats}`. Valida tenant, status y ventana (−30min/+60min). | `get_my_rol() IN (admin, recepcionista, staff)` | **No** |
| `qr-verify` (Netlify fn) → `check_in_atomic` | Función Netlify + RPC SECURITY DEFINER | `{ qr_payload }` + Bearer JWT del recepcionista | La fn valida el JWT del QR (HMAC-SHA256 timing-safe + expiración), luego llama `check_in_atomic(p_reserva_id)` con el token del recepcionista. | Mismo gate de rol en `check_in_atomic`; la fn exige Bearer token | **No** |
| Lecturas directas a tablas | PostgREST (RLS) | — | `usuarios`, `reservas`, `membresias`, `tiers`, `recursos` (ver hooks) | RLS (sección 6) | n/a |

- `check_in_manual_atomic` y `check_in_atomic` comparten el mismo gate de rol y
  son ambos `SECURITY DEFINER` (definición vigente en
  [20260514150000_perfil_extendido.sql](../../supabase/migrations/20260514150000_perfil_extendido.sql)).
- **Reutilizados de admin pero NO llamados por Recepción:** existen
  `gestionar_membresia_socio()` y `cancelar_reserva_atomic()` que ya aceptan
  `is_recepcionista()`, pero **ningún archivo de `src/reception/**` los invoca**.
  Quedan disponibles para Sub-rounds futuros.

### Funciones Netlify (`netlify/functions/`)

- **`qr-verify`** — la única que Recepción consume hoy ([index.ts](../../netlify/functions/qr-verify/index.ts)).
  Valida QR + delega en `check_in_atomic`. Las demás (`admin-create-user`,
  `admin-delete-user`, `admin-update-role`, `qr-issue`, `cron-no-shows`,
  `onboarding-crear-gym`, `fake-signup`) son de otros perímetros.

---

## 6. SISTEMA DE PERMISOS / SEGURIDAD

### Frontend (guards)

- Guard único en [ReceptionLayout.tsx:28-34](../../src/reception/ReceptionLayout.tsx#L28):
  - `isLoading` → `LoadingScreen`.
  - `!authUser` → redirect a `/login`.
  - `!usuario` → `LoadingScreen`.
  - `usuario.rol !== 'recepcionista' && usuario.rol !== 'admin'` → redirect a `/app`.
- No hay guards por-ruta ni condiciones de UI por sub-rol (admin vs recepcionista
  ven exactamente lo mismo en Recepción).

### Backend (RLS + helpers)

Helpers ([20260514100700_helper_functions.sql](../../supabase/migrations/20260514100700_helper_functions.sql)),
todos `SECURITY DEFINER STABLE`:
- `is_recepcionista()` → true si `rol IN ('recepcionista','admin')`.
- `is_admin()` → true sólo si `rol = 'admin'`.
- `get_my_user_id()`, `get_my_tenant_id()`, `get_my_rol()`.

Policies RLS relevantes para lo que Recepción lee:

| Tabla | Policy | Permite a recepcionista |
|---|---|---|
| `usuarios` | `usuarios_read_admin` USING `tenant_id=get_my_tenant_id() AND is_recepcionista()` | **Sí** (lee todo el tenant) |
| `reservas` | `reservas_read_admin` USING `… is_recepcionista()` | **Sí** |
| `membresia_movimientos` | `membresia_mov_read_staff` USING `… is_recepcionista()` | **Sí** (no usado aún por la UI de recepción) |
| `tiers` | `tiers_read_tenant` USING `tenant_id=get_my_tenant_id()` | **Sí** (cualquier authenticated del tenant) |
| `recursos` | `recursos_read_tenant` USING `tenant_id=get_my_tenant_id()` | **Sí** |
| **`membresias`** | `membresias_read_self` (self) / `membresias_read_admin` USING `… **is_admin()**` | **NO para recepcionista puro** |

> **⚠️ GAP DE RLS (real, alto valor).**
> `useSocioFicha` lee la tabla `membresias` directamente
> ([useSocioFicha.ts:108-114](../../src/reception/hooks/useSocioFicha.ts#L108)),
> pero la única policy de lectura amplia sobre `membresias` es
> `membresias_read_admin`, que usa **`is_admin()`**, no `is_recepcionista()`
> ([rls_policies.sql:141-144](../../supabase/migrations/20260514100800_rls_policies.sql#L141)).
> La otra policy, `membresias_read_self`, sólo deja ver la membresía **propia**.
> Consecuencia: un **recepcionista NO-admin** que abre la ficha de un socio
> recibe **0 filas** de `membresias` → la tarjeta de membresía cae a `null` y el
> estado se calcula como **"sin_plan"** aunque el socio tenga plan activo. La
> ficha "funciona" hoy sólo si quien la mira es **admin** (donde `is_admin()` es
> true). Las pruebas con mocks no exponen esto porque no pasan por RLS.

### Qué NO puede hacer Recepción que sí Admin

- Escribir/modificar membresías, recursos, tiers (policies `*_admin_all` exigen
  `is_admin()`).
- Leer `membresias` de otros (gap arriba).
- Leer `auditoria_recepcion` (policy `audrec_read_admin` exige `is_admin()`).
- En la UI: Recepción no tiene ninguna pantalla de escritura salvo el check-in.

### Qué SÍ puede Recepción que un socio no

- Leer **todos** los `usuarios` y `reservas` del tenant (un socio sólo ve lo
  propio).
- Hacer check-in de cualquier reserva del tenant (manual o QR) vía los RPC
  `SECURITY DEFINER` con gate de staff.

### Murallas de `auditoria_recepcion` (resumen; detalle en sección 7)

La tabla agrega 3 murallas de escritura + 1 capacidad testeada. Hoy **nadie
escribe** en ella (ningún RPC de producción inserta filas).

---

## 7. AUDITORÍA / BITÁCORA — `auditoria_recepcion`

Creada en [20260611000000_auditoria_recepcion.sql](../../supabase/migrations/20260611000000_auditoria_recepcion.sql).
Estado actual: **existe y está VACÍA** (ningún escritor en producción).

### Esquema (columnas)

`id` (uuid PK), `tenant_id` (FK tenants ON DELETE CASCADE), `actor_id` (FK
usuarios ON DELETE SET NULL), `actor_nombre` (text NOT NULL, snapshot),
`actor_rol` (CHECK ∈ {recepcionista, admin}), `accion` (text NOT NULL, **CHECK
con enum cerrado** de ~26 verbos "entidad.verbo"), `entidad` (CHECK ∈
{membresia,reserva,socio,clase,pago,checkin}), `entidad_id` (uuid), `socio_id`
(FK usuarios ON DELETE SET NULL), `socio_nombre` (text snapshot), `resumen` (text
NOT NULL, one-liner humano), `detalle` (jsonb `{antes,despues,extra}`),
`creado_en` (timestamptz DEFAULT now()).

Índices: `(tenant_id, creado_en DESC)`, `(tenant_id, actor_id)`,
`(tenant_id, socio_id)`, `(tenant_id, accion)`.

### Las murallas (cómo está implementada cada una)

1. **RLS — sólo admin del tenant LEE.** `ENABLE ROW LEVEL SECURITY` + policy
   `audrec_read_admin` (SELECT, `tenant_id=get_my_tenant_id() AND is_admin()`).
   **Sin policy de INSERT/UPDATE/DELETE** → ningún cliente puede escribir; sólo
   un RPC `SECURITY DEFINER` (que bypassa RLS) podría.
2. **Append-only: UPDATE bloqueado.** Trigger `audrec_no_update` BEFORE UPDATE →
   `trg_audrec_no_update()` siempre lanza `EXCEPTION 'append-only: UPDATE no
   permitido'` (bloquea incluso service_role).
3. **DELETE directo bloqueado, cascade permitido.** Trigger `audrec_no_delete`
   BEFORE DELETE → `trg_audrec_no_delete()`: si `pg_trigger_depth() > 1` (cascade
   del cierre de tenant) → `RETURN OLD`; si depth = 1 (delete directo) → EXCEPTION
   append-only.
4. **(Testeada, no es muralla estructural) SECURITY DEFINER SÍ puede insertar.**
   El test crea un helper `_audrec_test_definer` (SECURITY DEFINER, dropeado al
   final) y verifica que un definer puede insertar — el patrón que usarán los RPC
   del Sub-round 2.

El bloque `DO` de test valida las 4 cosas (RLS bloquea INSERT de `authenticated`;
UPDATE bloqueado; DELETE directo bloqueado; definer inserta), revierte las filas
de prueba con subtransacción + excepción centinela `ROLLBACK_TEST_DATA`, y aborta
la migración si algo falla. Atrapa sólo excepciones específicas (no `WHEN
others`).

### Quién la escribe / quién la ve

- **Escribe hoy:** **nadie.** Ni `check_in_atomic`, ni `check_in_manual_atomic`,
  ni ningún otro RPC inserta filas (verificado: ninguna migración fuera de la de
  creación menciona la tabla). El comentario de cabecera declara que los
  escritores llegan en **Sub-round 2**.
- **Ve hoy:** sólo **admin** vía RLS — pero como está vacía, no hay nada que ver.
  Una vista en el panel de admin está planeada para **Sub-round 5** (no existe en
  el código).

### Comparación con notas (son cosas distintas)

- `usuarios.notas_admin`: **campo único** de texto libre por socio (sin autor ni
  fecha). Es lo que muestra la ficha ("NOTAS SOBRE EL SOCIO") y el overlay de
  check-in. Read-only desde Recepción.
- `membresia_movimientos`: historial de movimientos de membresía (legible por
  staff vía RLS), distinto de la bitácora de auditoría. No usado por la UI de
  recepción hoy.
- `auditoria_recepcion`: bitácora de **acciones de staff** (quién hizo qué),
  append-only, aún vacía. No es lo mismo que las notas del socio.

---

## 8. PATRONES DE UX DE MOSTRADOR

| Patrón | Estado | Detalle |
|---|---|---|
| Motivo obligatorio en acciones sensibles | **No implementado** | El único campo motivo (check-in manual) es **opcional** ([ReservasHoyView.tsx:421-433](../../src/reception/components/ReservasHoyView.tsx#L421)). No hay otras acciones sensibles en Recepción. |
| Typed confirmation (escribir "CANCELAR") | **No implementado** | No existe ninguna acción destructiva en Recepción, ni confirmación por tipeo. |
| Errores traducidos a español | **Implementado** (en los paths de check-in) | `translateError` en [useReservasHoy.ts:71-82](../../src/reception/hooks/useReservasHoy.ts#L71) y en [qr-verify](../../netlify/functions/qr-verify/index.ts#L141). Mapea códigos `RESERVA_*`, `YA_CHECK_IN`, `DEMASIADO_*`, etc. Las lecturas directas (useSocios/useSocioFicha) sólo hacen `console.error`. |
| Pessimistic vs optimistic UI | **Pessimistic** | Todas las acciones esperan la respuesta del RPC antes de actualizar; luego `refetch`. No hay optimistic updates. |
| Scanner USB/HID | **Implementado** | `useScannerHID` (heurística ≥15 chars en <500ms + Enter, ignora inputs/textarea, se pausa con overlays). |
| Cámara con `@zxing/browser` | **Implementado** | `CameraModal` con `BrowserMultiFormatReader`, cámara trasera, cooldown 1.5s, fallback si falla `facingMode`. |
| Feedback sonoro / vibración | **No implementado** | No hay `navigator.vibrate`, `new Audio`, ni beep en `src/reception/**` (sólo `video.play()` de la cámara). |
| Auto-cierre de overlay (kiosco) | **Implementado** | `CheckInDetail` auto-cierra a 15s con cuenta regresiva visible. |
| Polling visibility-aware | **Parcial** | `useReservasHoy` hace polling cada 30s, pero **NO** chequea `document.visibilityState`/`visibilitychange` — sigue consultando con la pestaña en background. |
| Persistencia local (localStorage) de filtros/preferencias | **No implementado** | No hay `localStorage` en `src/reception/**` (el día visto, la query y el estado se pierden al recargar). *(La persistencia de colapso del sidebar es del AppSidebar en modo `collapsible`, que Recepción usa en modo plano — no aplica.)* |
| Sección "Llegando ahora" vs resto del día | **Implementado** | `ReservasHoyView` separa "Llegando ahora" (ventana ±15min, sólo hoy) de "Resto del día". |
| Credenciales "una sola vez" en alta/reset | **No implementado** | No existe alta de socio ni reset de password en Recepción. |

---

## 9. ESTADO DEL REDISEÑO EN CURSO

### Qué cambió la Pieza 1 (commit `0063121`)

Extrajo el sistema de shell oscuro de admin a 2 componentes compartidos y los
aplicó a Recepción. Archivos: `AppShell.tsx` (+90, nuevo), `AppSidebar.tsx`
(+326, nuevo), `AdminLayout.tsx` (−), `admin/Sidebar.tsx` (refactor a wrapper),
`ReceptionLayout.tsx` (migrado a `AppShell`/`AppSidebar`),
`SocioFichaPreview.tsx` (+99, TEMP). Resultado para Recepción: contorno con
sidebar oscuro teñido (desktop) + topbar/drawer (mobile), al nivel de admin.

> Commit posterior `6107f3d` (no era "Pieza 2"): pasó el header de miembro y el
> topbar mobile compartido a `--grad-immersive`. Toca la franja superior de
> Recepción en mobile.

### Qué quedó SIN ELEVAR todavía

- **Las pantallas internas**: Scanner, Socios y SocioFicha siguen con su propio
  `.ek-header-glass` (doble cabecera con el AppShell), estilos inline y clases
  `.rec-*` del lenguaje viejo. El botón "Salir" interno duplica el "Cerrar
  sesión" del sidebar.
- `ReservasHoyView`, `ReservaCard`, `ManualCheckInModal`, `CheckInDetail`,
  `CameraModal`: lenguaje viejo (inline + `.rec-*`), sin `.ek-card` con sombras
  teñidas ni headers display unificados.
- Empty states de las páginas internas: ya tienen ícono + texto, pero no el
  patrón "tinted" unificado del plan.

### Plan declarado de Piezas 2-5 (elevación visual)

No hay doc formal en `docs/`. Según el contexto de trabajo: Pieza 2 = headers
compartidos (eyebrow + título display), Pieza 3 = cards con sombras teñidas,
Pieza 4 = empty states teñidos, Pieza 5 = elevar `SocioFicha`. El FAB de cámara
debe conservarse. (Estado: declarado, **no** ejecutado en el HEAD.)

### Plan declarado de Sub-rounds 2-5 (rediseño funcional)

No documentado en `docs/`. Inferible del enum de `auditoria_recepcion` y sus
comentarios:
- **Sub-round 2:** RPCs `SECURITY DEFINER` que escriben la bitácora (check-ins +
  acciones de membresía/socio/reserva). Recepción pasa de read-only a escribir.
- **Sub-round 5:** vista de la bitácora en el panel de admin.
- Sub-rounds 3-4: no hay rastro explícito en código.

---

## 10. DEUDAS CONOCIDAS / TODOs / OBSERVACIONES

1. **GAP de RLS en `membresias` (alto):** `useSocioFicha` lee `membresias` pero
   la policy amplia usa `is_admin()`, no `is_recepcionista()`. Un recepcionista
   puro ve la ficha con membresía vacía → estado "sin_plan" falso. Ver sección 6.
   *(No hay comentario en el código que lo advierta — es un gap silencioso.)*

2. **TEMP-PREVIEW vive en `main`:** `SocioFichaPreview.tsx` + la ruta
   `/socios/_preview` + su lazy import están marcados "se borra antes del commit
   final del Sub-round 1" ([ReceptionLayout.tsx:13,57](../../src/reception/ReceptionLayout.tsx#L13)),
   pero se commitearon a `main` (commit `0063121`). Pendiente de borrar.

3. **Doble cabecera:** tras Pieza 1, el `AppShell` aporta logo+rol, pero cada
   página interna sigue con su `.ek-header-glass` (logo+rol+"Salir"). Redundancia
   visual y de acción (dos formas de cerrar sesión).

4. **Clases `.rec-*` posiblemente huérfanas:** `sala.css` define ~70 selectores
   `.rec-*` (incl. `.rec-card-*`, `.rec-day-*`, `.rec-day-today-btn`), pero
   `ReservasHoyView` renderiza las cards y el selector de día con **estilos
   inline + `.ek-card`**, no con esas clases. Parecen restos de una versión
   anterior. (Las usadas vivas son `.rec-detail-*`, `.rec-camera-*`,
   `.rec-shell`, `.rec-main`, `.rec-modal*`, `.rec-detail-backdrop`.)

5. **Sin UI de error en lecturas:** `useSocios` y `useReservasHoy` ante error de
   query sólo hacen `console.error` y muestran lista vacía — indistinguible de
   "no hay datos". Sólo los paths de check-in traducen y muestran el error.

6. **Polling no visibility-aware** y **sin persistencia local** (día/query/scroll
   se pierden al recargar) — ver sección 8.

7. **`check_in_atomic` no inspeccionado a fondo:** se documentó su gate de rol y
   que es el RPC del path QR (SECURITY DEFINER, no escribe auditoría); su cuerpo
   completo (ventana horaria exacta, mensajes) no se transcribió en este análisis
   por estar fuera del foco (es gemelo del manual).

8. **Sin tests en `src/reception/**`:** ninguna cobertura unitaria/integración
   propia del módulo.

---

*Fin del análisis. Estado: HEAD `6107f3d` de `main`. Documento de comparación
interno — no commitear.*
