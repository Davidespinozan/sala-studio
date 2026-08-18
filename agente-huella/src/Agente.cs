namespace SalaAgente;

/// <summary>
/// El cerebro: junta lector + matcher + API + almacén y corre el loop del mostrador.
/// Publica un texto de estado para que la bandeja muestre qué está pasando.
///
/// El loop, cada vuelta:
///   1) re-sincroniza las huellas si toca (cada N seg),
///   2) drena la cola de entradas offline si hay,
///   3) si recepción abrió una toma → enrola,
///   4) si no → espera un dedo y, si lo reconoce, marca la entrada.
/// </summary>
public sealed class Agente : IDisposable
{
    private readonly Config _cfg;
    private readonly SalaApi _api;
    private readonly Almacen _almacen;
    private readonly DigitalPersona4500 _lector; // es lector Y matcher (mismo motor)
    private readonly CancellationTokenSource _cts = new();
    private DateTimeOffset _ultimoSync = DateTimeOffset.MinValue;
    private DateTimeOffset _ultimoPendiente = DateTimeOffset.MinValue;

    /// <summary>Último mensaje de estado (para la bandeja / logs).</summary>
    public event Action<string>? Estado;

    public Agente(Config cfg, string carpetaDatos)
    {
        _cfg = cfg;
        _api = new SalaApi(cfg);
        _almacen = new Almacen(carpetaDatos);
        _lector = new DigitalPersona4500(cfg.UmbralMatch);
    }

    public void Iniciar() => _ = Task.Run(LoopAsync);

    private async Task LoopAsync()
    {
        var ct = _cts.Token;
        Log.Escribir("── Agente arrancando (v7 · auto-reconexión + refresco + arranque resiliente) ──");
        try
        {
            _lector.Abrir();
            Avisar($"Lector listo: {_lector.Nombre}");
            Log.Escribir($"Lector listo: {_lector.Nombre}");
            await Sync(ct); // arrancar con las huellas frescas
        }
        catch (Exception ex)
        {
            // Arranque resiliente: si el lector no está listo al abrir el agente (aún
            // no conectado, o Windows no cargó el driver al encender), NO morimos —
            // esperamos a que aparezca y lo abrimos solos (misma reconexión del loop).
            Avisar("Sin lector al arrancar — esperando a que lo conecten…");
            Log.Escribir($"Arranque sin lector: {ex.Message}. Esperando a que aparezca…");
            await ReconectarAsync(ct);
        }

        // Si el lector se DUERME sin dar error (Windows suspende el USB), Capture solo
        // devuelve "sin dedo" para siempre y la auto-reconexión del v6 no se enteraba.
        // Backstop: tras mucho rato de puras capturas "sin dedo", refrescamos el lector
        // por dentro (reabrir) por si se durmió — sin que nadie cierre/abra el agente.
        int sinActividad = 0;
        const int RefrescoTrasSinActividad = 60; // ~3 min de capturas "sin dedo" seguidas

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await TalvezSync(ct);
                await TalvezDrenar(ct);

                var pendiente = await TalvezPendiente(ct);
                if (pendiente is not null) { sinActividad = 0; await Enrolar(pendiente, ct); continue; }

                // Check-in: esperar un dedo, con timeout corto para volver a revisar pendientes.
                var captura = await _lector.CapturarUnaAsync(TimeSpan.FromSeconds(3), ct);
                if (captura is null)
                {
                    if (++sinActividad >= RefrescoTrasSinActividad)
                    {
                        sinActividad = 0;
                        Log.Escribir("Refresco preventivo del lector (mucho rato sin actividad)…");
                        try { _lector.Reabrir(); Log.Escribir("Lector refrescado ✓"); await Sync(ct); }
                        catch (Exception ex) { Log.Escribir($"Refresco falló: {ex.Message}"); await ReconectarAsync(ct); }
                    }
                    continue;
                }
                sinActividad = 0;

                var usuarioId = _lector.Identificar(captura.PlantillaIso, _almacen.Huellas);
                if (usuarioId is null) { Avisar("Huella no reconocida"); continue; }

                await RegistrarEntrada(usuarioId, ct);
            }
            catch (LectorDesconectadoException ex)
            {
                sinActividad = 0;
                Avisar("Lector desconectado — reconectando…");
                Log.Escribir($"Lector desconectado: {ex.Message}. Reconectando…");
                await ReconectarAsync(ct);
            }
            catch (LectorNoAutorizadoException ex) { Avisar($"Token inválido: {ex.Message}"); Log.Escribir($"Token inválido: {ex.Message}"); await Esperar(30, ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { Avisar($"Error: {ex.Message}"); Log.Escribir($"Error en loop: {ex}"); await Esperar(3, ct); }
        }
    }

    /// <summary>
    /// El lector se cayó (se desenchufó o dejó de responder). Espera a que vuelva a
    /// aparecer físicamente y lo reabre solo — sin que nadie reinicie el agente.
    /// Reintenta en bucle hasta lograrlo (o hasta que se cancele el agente).
    /// </summary>
    private async Task ReconectarAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await Esperar(2, ct);
            if (!_lector.HayLectorFisico()) continue; // aún desconectado: seguir esperando
            try
            {
                _lector.Reabrir();
                Avisar($"Lector reconectado: {_lector.Nombre}");
                Log.Escribir("Lector reconectado ✓");
                await Sync(ct); // refrescar huellas al volver
                return;
            }
            catch (Exception ex)
            {
                Log.Escribir($"Reintento de reconexión falló, sigo intentando: {ex.Message}");
            }
        }
    }

    private async Task RegistrarEntrada(string usuarioId, CancellationToken ct)
    {
        var momento = DateTimeOffset.Now;
        try
        {
            var r = await _api.CheckInAsync(usuarioId, momento, ct);
            Avisar(string.IsNullOrWhiteSpace(r.Mensaje) ? "Entrada registrada" : r.Mensaje!);
        }
        catch (HttpRequestException) // sin internet: encolar y seguir operando
        {
            _almacen.Encolar(new EntradaPendiente(usuarioId, momento));
            Avisar($"Entrada guardada (sin internet). En cola: {_almacen.PendientesCount}");
        }
    }

    private async Task Enrolar(PendienteResp p, CancellationToken ct)
    {
        Avisar($"Apoya el {p.Dedo}, {p.Socio}… (0/4)");
        Log.Escribir($"Enrolar: toma abierta para {p.Socio} ({p.Dedo})");
        var captura = await _lector.EnrolarAsync(
            n => Avisar($"{p.Socio}: {n}/4 tomas — apoya de nuevo el {p.Dedo}"), ct);
        if (captura is null) { Avisar("Enrolamiento cancelado"); Log.Escribir("Enrolar: cancelado / no juntó 4 tomas"); return; }
        try
        {
            await _api.EnrolarAsync(p.EnrolamientoId!, Convert.ToBase64String(captura.PlantillaIso), captura.Calidad, ct);
            Avisar("Huella registrada ✓");
            await Sync(ct); // que la huella nueva entre al cache de inmediato
        }
        catch (Exception ex) { Avisar($"No se pudo guardar la huella: {ex.Message}"); }
    }

    // ── Tareas de fondo, con throttle ────────────────────────────────────────
    private async Task TalvezSync(CancellationToken ct)
    {
        if ((DateTimeOffset.Now - _ultimoSync).TotalSeconds >= _cfg.SyncCadaSegundos)
            await Sync(ct);
    }

    private async Task Sync(CancellationToken ct)
    {
        _almacen.ReemplazarHuellas(await _api.SyncAsync(ct));
        _ultimoSync = DateTimeOffset.Now;
        Avisar($"Huellas al día ({_almacen.Huellas.Count})");
    }

    private async Task<PendienteResp?> TalvezPendiente(CancellationToken ct)
    {
        if ((DateTimeOffset.Now - _ultimoPendiente).TotalSeconds < _cfg.PendienteCadaSegundos) return null;
        _ultimoPendiente = DateTimeOffset.Now;
        return await _api.PendienteAsync(ct);
    }

    private Task TalvezDrenar(CancellationToken ct) =>
        _almacen.PendientesCount == 0
            ? Task.CompletedTask
            : _almacen.DrenarAsync(async e =>
            {
                try { await _api.CheckInAsync(e.UsuarioId, e.Momento, ct); return true; }
                catch { return false; }
            });

    private static Task Esperar(int seg, CancellationToken ct) => Task.Delay(TimeSpan.FromSeconds(seg), ct);
    private void Avisar(string s) => Estado?.Invoke(s);

    public void Dispose() { _cts.Cancel(); _lector.Dispose(); }
}
