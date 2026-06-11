# DECISIONS

Decisiones de producto/arquitectura durables de SALA. Numeradas `D-NNN`.
Históricamente se referenciaban en comentarios de código; desde D-021 se
documentan acá.

---

## D-021 — Dos capas de color: MARCA (del tenant) + SEMÁNTICA (fija)

**Estado:** aprobada · 2026-06-11

SALA tiene **dos capas de color que coexisten sin contradicción**:

- **Capa MARCA** — deriva del tenant (`--sala-primary`, `--sala-accent` y sus
  derivados). Cubre: CTAs, branding, decoración, sidebar/nav inmersivos,
  sombras, glows, focus rings, fondos tintados. Cada gym tiene su atmósfera.
- **Capa SEMÁNTICA** — colores **fijos del sistema** (verde éxito, ámbar
  warning, rojo error, gris neutral). Cubre: estado de membresía
  (activa/pausada/vencida/sin-plan), estado de reservas
  (confirmada/cancelada/no-show), alertas de pago/bloqueo, errores de
  formulario, success de acciones, warnings. **NO deriva del tenant** — es
  código visual universal que el usuario interpreta en milisegundos sin leer.

Un tenant azul tiene su sidebar azul (marca) **y** sus badges rojos para
"vencida" (semántica). Son códigos distintos.

**Regla para decidir (futuro):** ¿esto es decoración/branding, o es info de
estado que el usuario lee en milisegundos? → estado = semántico; decoración =
marca del tenant.

**Aplicación ACOTADA:** la capa semántica es **solo para info de estado
operativa** (membresía, reservas, pago/bloqueo, errores, success, warnings). NO
es licencia para meter verde/rojo en CTAs, headers, decoración o focus rings —
ahí manda la marca del tenant.

**Tokens:** usar los semánticos fijos de Fase A (`--sala-warning`,
`--sala-error`, `--sala-success`, neutrales). Si falta un tono semántico (ej.
info azul), se agrega explícitamente al sistema como token semántico fijo, NO
derivado del tenant.

**Consecuencia técnica (a aplicar):** el remap que hoy hace `applyBranding`
(warning→primario, error→acento para tenants) **contradice esta decisión** y
debe revertirse: los tokens semánticos quedan fijos para todos los tenants. La
clase `.sala-brand` conserva el lock de primary/accent (capa marca) de las
superficies propias de SALA; su override de warning/error se vuelve redundante.

**Revisa decisión previa:** la elección anterior de "estados monocromos para
tenants" (de la primera ronda de branding) queda **superada** por D-021.
