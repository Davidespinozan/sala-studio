# Compilar el agente SIN tener Windows (fábrica automática)

El `.exe` se compila **solo, en la nube** (GitHub Actions, en una máquina Windows
prestada). Tú no necesitas Windows ni instalar nada de desarrollo. Solo haces
esto **una vez** y, cada vez que quieras una versión nueva, aprietas un botón.

## Lo único que hay que conseguir a mano: el SDK de DigitalPersona

El agente usa una librería del fabricante (`DPUruNet.dll`) que **no se puede subir
a un repo público** (licencia). Se consigue gratis:

1. Entra al portal de desarrolladores de **HID / DigitalPersona** y crea una cuenta.
   Busca **"U.are.U SDK"** (o "DigitalPersona SDK") para **Windows**.
2. Descárgalo e instálalo/descomprímelo. Adentro (carpeta `Bin` o similar) está el
   archivo **`DPUruNet.dll`**. Ese es el único que necesitamos.

> Ese mismo SDK trae el **driver del lector** — guárdalo, porque en la compu del
> mostrador hay que instalarlo para que el 4500 funcione (el agente lo usa).

## Configuración (una sola vez)

### 1. Sube `DPUruNet.dll` a un bucket privado de Supabase
- En el dashboard de Supabase → **Storage** → **New bucket** → nombre **`sdk`**,
  **NO público** (privado).
- Sube ahí el archivo **`DPUruNet.dll`** (tal cual, con ese nombre).

### 2. Pon 2 secrets en GitHub
- En GitHub → el repo → **Settings → Secrets and variables → Actions → New secret**.
- Crea:
  - **`SUPABASE_URL`** = la URL de tu proyecto (ej. `https://xxxx.supabase.co`).
  - **`SUPABASE_SERVICE_ROLE_KEY`** = la *service role key* (Supabase → Settings →
    API). Es sensible; en GitHub queda oculta y segura.

## Generar el `.exe` (esto sí es un botón)

- GitHub → pestaña **Actions** → workflow **"Compilar agente de huella"** →
  **Run workflow**.
- En ~3–5 min compila y **publica** el instalador como *Release* con tag `agente`.
- La URL pública queda fija:
  `https://github.com/Davidespinozan/sala-studio/releases/download/agente/SalaAgente.exe`
  — que es justo a donde ya apunta el botón **"Descargar agente"** de Lectores.

**Listo.** El paso 1 de la ventana de Lectores se enciende solo. Cada vez que
mejore el agente, corres el workflow otra vez y todos bajan la versión nueva desde
la misma URL.

## (Opcional, después) Firmar el `.exe`
Sin firma, Windows muestra una alerta "app desconocida" (se le da "ejecutar de
todos modos"). Para quitarla se compra un certificado de firma de código y se
agrega un paso `signtool` al workflow. No es urgente.

## Probarlo (con el lector real)
1. En la compu del mostrador (Windows): instala el **driver** del 4500 (viene en el
   SDK) y conecta el lector.
2. Baja el agente + la config desde Lectores, ponlos en la misma carpeta, abre el
   `.exe`. Debe aparecer el icono en la barra y, en Lectores, "Conectado".
