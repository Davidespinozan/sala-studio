# Generar el instalador del agente (sin Windows, sin bajar nada)

El `.exe` se compila **solo, en la nube** (GitHub Actions, máquina Windows prestada).
La librería de DigitalPersona viene de **NuGet**, así que se baja sola al compilar.

## Lo único que haces: apretar un botón

1. GitHub → repo → pestaña **Actions**.
2. Elige el workflow **"Compilar agente de huella"**.
3. **Run workflow**.

En ~3–5 min compila y **publica** el instalador como *Release* con tag `agente`.
La URL pública queda fija:

```
https://github.com/Davidespinozan/sala-studio/releases/download/agente/SalaAgente.exe
```

— que es justo a donde ya apunta el botón **"Descargar agente"** de la sección
Lectores. **Con la primera corrida, el botón se enciende solo.**

Eso es todo. No hay que bajar el SDK, ni subir nada a Supabase, ni poner secrets.

## Lo que SÍ instala cada gym en la compu del mostrador (no tú)
- El **driver/runtime del lector** (viene con el DigitalPersona o de su sitio) — es
  lo que hace que el 4500 funcione en Windows y trae las piezas nativas que el
  agente usa por debajo.
- El **agente** + su **config**, descargados desde Lectores (doble click).

## (Opcional, después) Firmar el `.exe`
Sin firma, Windows muestra "app desconocida" (se le da "ejecutar de todos modos").
Para quitarlo se compra un certificado y se agrega un paso `signtool` al workflow.
No es urgente.

## Si algo falla en la compilación
Abre la corrida en Actions y mira el log del paso "Compilar el .exe". El error más
común sería que el paquete `DigitalPersona.dpUruNet` cambie de versión — se ajusta
en `agente-huella/SalaAgente.csproj`.
