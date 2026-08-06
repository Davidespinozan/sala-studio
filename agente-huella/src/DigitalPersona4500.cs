using System.Threading.Channels;
using DPUruNet;

namespace SalaAgente;

/// <summary>
/// El adaptador del DigitalPersona U.are.U 4500 (el ÚNICO pedazo específico de marca).
/// Implementa captura + enrolamiento (ILectorHuella) y el motor de comparación
/// (IMatcher). Todo sobre plantillas ANSI 378, así el resto del agente es genérico.
///
/// CAPTURA POR EVENTOS (streaming), no bloqueante:
///   El método bloqueante Reader.Capture() resultó poco confiable con este lector/
///   driver (devolvía "éxito" sin imagen, o timeout, aunque el foco prendiera). El
///   camino probado del 4500 es el streaming: se arranca UNA vez con CaptureAsync y
///   el SDK dispara On_Captured por cada dedo apoyado. Metemos cada captura en una
///   cola; capturar = leer de la cola con timeout.
/// </summary>
public sealed class DigitalPersona4500(int umbralMatch) : ILectorHuella, IMatcher
{
    private Reader? _reader;

    // Cola de capturas que llegan por evento. Acotada y con DropOldest: si se
    // acumulan (nadie las lee), nos quedamos con la más reciente, no con basura vieja.
    private readonly Channel<Fid> _capturas = Channel.CreateBounded<Fid>(
        new BoundedChannelOptions(4) { FullMode = BoundedChannelFullMode.DropOldest });

    public string Nombre => _reader?.Description.Name.ToString() ?? "DigitalPersona U.are.U 4500";

    public void Abrir()
    {
        var readers = ReaderCollection.GetReaders();
        Log.Escribir($"Abrir: {readers.Count} lector(es) detectado(s)");
        if (readers.Count == 0)
            throw new InvalidOperationException("No hay ningún lector conectado. Revisa el USB y el driver.");

        _reader = readers[0]; // un mostrador = un lector
        var r = _reader.Open(Constants.CapturePriority.DP_PRIORITY_COOPERATIVE);
        Log.Escribir($"Open → {r}");
        if (r != Constants.ResultCode.DP_SUCCESS)
            throw new InvalidOperationException($"No se pudo abrir el lector ({r}).");

        _reader.On_Captured += OnCaptured;
        var cr = _reader.CaptureAsync(
            Constants.Formats.Fid.ANSI,
            Constants.CaptureProcessing.DP_IMG_PROC_DEFAULT,
            _reader.Capabilities.Resolutions[0]);
        Log.Escribir($"CaptureAsync (arranque streaming) → {cr}");
        if (cr != Constants.ResultCode.DP_SUCCESS)
            throw new InvalidOperationException($"No se pudo iniciar la captura ({cr}).");
    }

    /// <summary>El SDK nos avisa acá cada vez que alguien apoya el dedo.</summary>
    private void OnCaptured(CaptureResult cr)
    {
        Log.Escribir(
            $"On_Captured RC={cr?.ResultCode} Quality={cr?.Quality} Data={(cr?.Data is null ? "null" : "ok")}");
        if (cr?.ResultCode == Constants.ResultCode.DP_SUCCESS && cr.Data is not null)
            _capturas.Writer.TryWrite(cr.Data);
    }

    /// <summary>Espera la próxima captura de la cola, o null si pasó el timeout.</summary>
    private async Task<Fid?> SiguienteFidAsync(TimeSpan timeout, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try { return await _capturas.Reader.ReadAsync(cts.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return null; } // solo timeout
    }

    // ── Captura para CHECK-IN ───────────────────────────────────────────────
    public async Task<Captura?> CapturarUnaAsync(TimeSpan timeout, CancellationToken ct)
    {
        var fid = await SiguienteFidAsync(timeout, ct);
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
            var fid = await SiguienteFidAsync(TimeSpan.FromSeconds(20), ct);
            if (fid is null) continue; // aún no apoyó el dedo → seguir esperando

            var res = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.ANSI);
            Log.Escribir($"Enrolar: extracción de rasgos → {res.ResultCode} (van {tomas.Count}/4)");
            if (res.ResultCode == Constants.ResultCode.DP_SUCCESS)
            {
                tomas.Add(res.Data);
                onAvance?.Invoke(tomas.Count); // "vas 1/4, 2/4…" a la bandeja
            }
        }
        if (tomas.Count < 4) return null; // cancelado antes de completar

        // SDK: combina las 4 tomas en la plantilla final de enrolamiento.
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
    /// Carga bytes de plantilla (formato ANSI 378) como Fmd comparable.
    /// Nota: este build de DPUruNet expone ANSI en el enum Fmd, no ISO — por eso
    /// todo el agente usa ANSI 378. Como el matching es local y consistente
    /// (enrola y compara en el mismo formato), es indistinto.
    /// </summary>
    private static Fmd ImportarPlantilla(byte[] datos) =>
        Importer.ImportFmd(datos, Constants.Formats.Fmd.ANSI, Constants.Formats.Fmd.ANSI).Data;

    public void Dispose()
    {
        try
        {
            if (_reader is not null)
            {
                _reader.On_Captured -= OnCaptured;
                _reader.CancelCapture();
            }
        }
        catch { /* al cerrar, si el SDK se queja, no importa */ }
        _reader?.Dispose();
    }
}
