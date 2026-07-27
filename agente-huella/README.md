# Agente de huella SALA

El **agente local** que corre en la PC del mostrador: habla con el lector de huella
por USB (SDK del fabricante) y con SALA por HTTPS. Es el único componente que
faltaba — todo el lado de SALA (endpoints, tablas, enrolamiento, check-in) ya está.

## Arquitectura (por qué así)

```
[ Núcleo del agente ]   ← escrito UNA vez, sirve para cualquier lector
   ├─ SalaApi        → los 4 llamados: sync / pendiente / enrolar / checkin-lector
   ├─ Almacen        → cache de plantillas (para comparar offline) + cola de entradas
   └─ ILectorHuella  → INTERFAZ común (capturar → plantilla ISO 19794-2)
          └─ DigitalPersona4500Lector   ← el ÚNICO pedazo específico por marca
```

- El núcleo **no sabe** qué lector es: solo pide "dame una plantilla ISO".
- Agregar otra marca (ZKTeco, SecuGen…) = **una clase nueva** que implementa
  `ILectorHuella`. No se toca el núcleo ni SALA.
- El **matching** se hace **local** (con el motor del SDK, sobre plantillas ISO),
  así el check-in funciona aunque se caiga el internet.

## Contratos con SALA (ya en producción)

- `POST /huella-agente` con `{ accion, token, ... }`:
  - `sync` → `{ ok, huellas: [{ usuario_id, dedo, formato, plantilla(base64 ISO) }] }`
  - `pendiente` → `{ ok, pendiente:false }` o `{ ok, pendiente:true, enrolamiento_id, dedo, socio }`
  - `enrolar` → `{ accion:'enrolar', token, enrolamiento_id, plantilla(base64), formato:'iso19794-2', calidad }`
- `POST /checkin-lector` con `{ token, usuario_id, momento(ISO 8601) }`.

El **token** lo genera el admin en **Admin → Lectores** (se ve una sola vez).

## Cómo se compila

Lo normal es **no compilar a mano**: el workflow de GitHub Actions lo hace solo
(ver [BUILD.md](BUILD.md) → apretar "Run workflow"). La librería `DPUruNet` viene
de **NuGet** (`DigitalPersona.dpUruNet`, ver el `.csproj`), así que se restaura
sola — no hay que bajar ningún DLL.

Requisito para compilar en local (opcional): **.NET 8 SDK** en Windows. El
**driver/runtime nativo del lector** (del sitio de DigitalPersona) va en la PC del
mostrador para que el agente funcione en ejecución.

## Compilar un .exe autocontenido (un solo archivo)

```powershell
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
```

Sale `SalaAgente.exe` en `bin/Release/net8.0-windows/win-x64/publish/`.

## Configuración

Junto al `.exe`, un archivo **`sala-lector.config.json`**:

```json
{
  "apiBase": "https://www.salastudio.app/.netlify/functions",
  "token": "EL-TOKEN-DEL-LECTOR",
  "syncCadaSegundos": 60,
  "pendienteCadaSegundos": 2,
  "umbralMatch": 21474
}
```

En la distribución **auto-servicio** (Fase 2), este archivo lo genera SALA con el
token ya adentro, así el gym solo descarga y hace doble click.

## Firma de código (recomendado, para que Windows no alarme)

Sin firmar, Windows SmartScreen muestra "app desconocida". Con un certificado de
firma de código (~$100–300/año):

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f cert.pfx /p CLAVE SalaAgente.exe
```

## Probar

Se necesita el **lector físico** conectado + Windows. Pasos:
1. Da de alta un lector en Admin → Lectores, copia el token.
2. Ponlo en `sala-lector.config.json`.
3. Corre `SalaAgente.exe`. En Admin → Lectores debe verse "visto hace un momento".
4. Enrola una huella desde recepción (Tomar huella) → el agente la captura y la sube.
5. Apoya el dedo → debe marcar el check-in.

> Este agente no se puede probar sin el hardware; el código está escrito contra la
> API de DPUruNet y los contratos de SALA, pero **la validación final es con el 4500 real**.
