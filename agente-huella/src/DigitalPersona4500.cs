using DPUruNet;

namespace SalaAgente;

/// <summary>
/// El adaptador del DigitalPersona U.are.U 4500 (el ÚNICO pedazo específico de marca).
/// Implementa captura + enrolamiento (ILectorHuella) y el motor de comparación
/// (IMatcher). Todo sobre plantillas ANSI 378, así el resto del agente es genérico.
///
/// CAPTURA BLOQUEANTE (Reader.Capture) — el streaming por eventos (CaptureAsync +
/// On_Captured) NO entrega eventos con este driver/lector (armaba con DP_SUCCESS
/// pero On_Captured nunca disparaba). El bloqueante SÍ mueve el lector (el foco
/// prende al apoyar el dedo). Cada intento deja su rastro en el log para ver
/// exactamente qué devuelve el SDK.
/// </summary>
public sealed class DigitalPersona4500(int umbralMatch) : ILectorHuella, IMatcher
{
    private Reader? _reader;

    public string Nombre => _reader?.Description.Name.ToString() ?? "DigitalPersona U.are.U 4500";

    public void Abrir()
    {
        var readers = ReaderCollection.GetReaders();
        Log.Escribir($"Abrir: {readers.Count} lector(es) detectado(s)");
        if (readers.Count == 0)
            throw new InvalidOperationException("No hay ningún lector conectado. Revisa el USB y el driver.");

        _reader = readers[0]; // un mostrador = un lector

        // EXCLUSIVO primero: si otro programa (el sistema anterior del gym, la app
        // demo de DigitalPersona…) tiene el lector, con COOPERATIVE nos quedábamos
        // en TIMED_OUT eterno "sin ver el dedo" y sin pista alguna (E: numa, ago
        // 2026). Exclusivo o truena aquí con mensaje claro, o el lector es nuestro.
        var r = _reader.Open(Constants.CapturePriority.DP_PRIORITY_EXCLUSIVE);
        Log.Escribir($"Open (exclusivo) → {r}");
        if (r != Constants.ResultCode.DP_SUCCESS)
        {
            Log.Escribir("⚠ No se pudo abrir en exclusivo: OTRO PROGRAMA está usando el lector.");
            Log.Escribir("⚠ Cierra el otro sistema de huellas (o quítalo del arranque) y vuelve a abrir este agente.");
            r = _reader.Open(Constants.CapturePriority.DP_PRIORITY_COOPERATIVE);
            Log.Escribir($"Open (cooperativo, plan B) → {r}");
        }
        if (r != Constants.ResultCode.DP_SUCCESS)
            throw new InvalidOperationException($"No se pudo abrir el lector ({r}).");
    }

    // Timeouts seguidos: con dedo puesto no deberían pasar. Si se acumulan, casi
    // siempre es conflicto con otro programa o falta el runtime de DigitalPersona.
    private int _timeoutsSeguidos;

    // ── Captura para CHECK-IN ───────────────────────────────────────────────
    public async Task<Captura?> CapturarUnaAsync(TimeSpan timeout, CancellationToken ct)
    {
        var fid = await CapturarFidAsync(timeout, ct);
        if (fid is null) return null;

        var res = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.ANSI);
        return res.ResultCode == Constants.ResultCode.DP_SUCCESS
            ? new Captura(res.Data.Bytes, 90)
            : null;
    }

    // ── Captura para ENROLAMIENTO (4 tomas → 1 plantilla robusta) ────────────
    public async Task<Captura?> EnrolarAsync(Action<int>? onAvance, CancellationToken ct)
    {
        var tomas = new List<Fmd>();
        while (tomas.Count < 4 && !ct.IsCancellationRequested)
        {
            var fid = await CapturarFidAsync(TimeSpan.FromSeconds(15), ct);
            if (fid is null) continue; // aún no apoyó el dedo (o lectura mala) → reintentar

            var res = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.ANSI);
            Log.Escribir($"Enrolar: extracción de rasgos → {res.ResultCode} (van {tomas.Count}/4)");
            if (res.ResultCode == Constants.ResultCode.DP_SUCCESS)
            {
                tomas.Add(res.Data);
                onAvance?.Invoke(tomas.Count); // "vas 1/4, 2/4…" a la bandeja
            }
        }
        if (tomas.Count < 4) return null; // cancelado antes de completar

        var enroll = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.ANSI, tomas);
        Log.Escribir($"Enrollment.CreateEnrollmentFmd → {enroll.ResultCode}");
        return enroll.ResultCode == Constants.ResultCode.DP_SUCCESS
            ? new Captura(enroll.Data.Bytes, 100)
            : null;
    }

    // ── Matching (IMatcher): compara la captura contra las huellas cacheadas ─
    public string? Identificar(byte[] capturaIso, IReadOnlyList<HuellaCache> candidatas)
    {
        var fmdCaptura = ImportarPlantilla(capturaIso);
        foreach (var c in candidatas)
        {
            var cmp = Comparison.Compare(fmdCaptura, 0, ImportarPlantilla(c.PlantillaIso), 0);
            // El score es una PROBABILIDAD de falso positivo: bajo = misma persona.
            if (cmp.ResultCode == Constants.ResultCode.DP_SUCCESS && cmp.Score < umbralMatch)
                return c.UsuarioId;
        }
        return null;
    }

    // ── Internos ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Captura BLOQUEANTE del SDK, en un hilo aparte para no congelar el loop.
    /// Loguea SIEMPRE el resultado (ResultCode + Quality + si trajo imagen): es lo
    /// que necesitábamos ver para saber por qué una toma se acepta o se rechaza.
    /// </summary>
    private Task<Fid?> CapturarFidAsync(TimeSpan timeout, CancellationToken ct) => Task.Run(() =>
    {
        if (_reader is null) throw new LectorDesconectadoException("Lector no abierto.");

        CaptureResult cr;
        try
        {
            cr = _reader.Capture(
                Constants.Formats.Fid.ANSI,
                Constants.CaptureProcessing.DP_IMG_PROC_DEFAULT,
                (int)timeout.TotalMilliseconds,
                _reader.Capabilities.Resolutions[0]);
        }
        catch (Exception ex)
        {
            // El SDK lanzó (típico al desenchufar el lector a media captura).
            throw new LectorDesconectadoException($"Capture lanzó: {ex.Message}");
        }

        Log.Escribir($"Capture → RC={cr?.ResultCode} Quality={cr?.Quality} Data={(cr?.Data is null ? "null" : "ok")}");

        // Lector desconectado: Capture no devuelve nada, o devuelve un código que NO
        // es éxito. Un TIMED_OUT normal (sin dedo) viene como DP_SUCCESS + calidad,
        // así que esto SOLO pega cuando el aparato falla / se desenchufa → reconectar.
        if (cr is null || cr.ResultCode != Constants.ResultCode.DP_SUCCESS)
            throw new LectorDesconectadoException($"Capture RC={cr?.ResultCode.ToString() ?? "null"}");

        if (cr.Data is null) return null;

        // TIMED_OUT = no hubo dedo en la ventana: el Data que acompaña es basura y
        // extraer rasgos de él solo ensuciaba el log con DP_INVALID_FID (van 0/4).
        if (cr.Quality == Constants.CaptureQuality.DP_QUALITY_TIMED_OUT)
        {
            _timeoutsSeguidos++;
            if (_timeoutsSeguidos % 20 == 0)
                Log.Escribir("⚠ Muchas capturas sin dedo seguidas. Si SÍ están poniendo el dedo: " +
                             "otro programa está usando el lector (ciérralo) o falta el runtime de DigitalPersona.");
            return null;
        }
        _timeoutsSeguidos = 0;

        // NO exigimos DP_QUALITY_GOOD: dejamos que FeatureExtraction juzgue. Una
        // imagen inservible falla en la extracción y se reintenta.
        return cr.Data;
    }, ct);

    /// <summary>¿Hay un lector físicamente conectado? (para esperar a que vuelva).</summary>
    public bool HayLectorFisico()
    {
        try { return ReaderCollection.GetReaders().Count > 0; }
        catch { return false; }
    }

    /// <summary>Cierra el handle viejo y vuelve a abrir el lector (tras reconectarlo).</summary>
    public void Reabrir()
    {
        try { _reader?.Dispose(); } catch { /* handle ya inválido */ }
        _reader = null;
        Abrir();
    }

    /// <summary>
    /// Carga bytes de plantilla (formato ANSI 378) como Fmd comparable.
    /// Nota: este build de DPUruNet expone ANSI en el enum Fmd, no ISO — por eso
    /// todo el agente usa ANSI 378. Como el matching es local y consistente
    /// (enrola y compara en el mismo formato), es indistinto.
    /// </summary>
    private static Fmd ImportarPlantilla(byte[] datos) =>
        Importer.ImportFmd(datos, Constants.Formats.Fmd.ANSI, Constants.Formats.Fmd.ANSI).Data;

    public void Dispose() => _reader?.Dispose();
}

/// <summary>El lector se desconectó (o dejó de responder). El agente lo reabre solo.</summary>
public sealed class LectorDesconectadoException(string mensaje) : Exception(mensaje);