using DPUruNet;

namespace SalaAgente;

/// <summary>
/// El adaptador del DigitalPersona U.are.U 4500 (el ÚNICO pedazo específico de marca).
/// Implementa captura + enrolamiento (ILectorHuella) y el motor de comparación
/// (IMatcher). Todo sobre plantillas ISO 19794-2, así el resto del agente es genérico.
///
/// Escrito contra la API de DPUruNet (SDK de HID/DigitalPersona). Si tu versión del
/// SDK difiere en alguna firma, los puntos a revisar están marcados con «SDK:».
/// </summary>
public sealed class DigitalPersona4500(int umbralMatch) : ILectorHuella, IMatcher
{
    private Reader? _reader;

    public string Nombre => _reader?.Description.Name.ToString() ?? "DigitalPersona U.are.U 4500";

    public void Abrir()
    {
        var readers = ReaderCollection.GetReaders();
        if (readers.Count == 0)
            throw new InvalidOperationException("No hay ningún lector conectado. Revisa el USB y el driver.");

        _reader = readers[0]; // un mostrador = un lector
        var r = _reader.Open(Constants.CapturePriority.DP_PRIORITY_COOPERATIVE);
        if (r != Constants.ResultCode.DP_SUCCESS)
            throw new InvalidOperationException($"No se pudo abrir el lector ({r}).");
    }

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
    public async Task<Captura?> EnrolarAsync(CancellationToken ct)
    {
        var tomas = new List<Fmd>();
        while (tomas.Count < 4 && !ct.IsCancellationRequested)
        {
            var fid = await CapturarFidAsync(TimeSpan.FromSeconds(15), ct);
            if (fid is null) continue; // aún no apoyó el dedo → reintentar

            var res = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.ANSI);
            if (res.ResultCode == Constants.ResultCode.DP_SUCCESS)
                tomas.Add(res.Data);
        }
        if (tomas.Count < 4) return null; // cancelado antes de completar

        // SDK: combina las 4 tomas en la plantilla final de enrolamiento.
        var enroll = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.ANSI, tomas);
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

    /// <summary>Captura BLOQUEANTE del SDK, sacada a un hilo para no congelar el loop.</summary>
    private Task<Fid?> CapturarFidAsync(TimeSpan timeout, CancellationToken ct) => Task.Run(() =>
    {
        if (_reader is null) throw new InvalidOperationException("Lector no abierto.");
        var cr = _reader.Capture(
            Constants.Formats.Fid.ANSI,
            Constants.CaptureProcessing.DP_IMG_PROC_DEFAULT,
            (int)timeout.TotalMilliseconds,
            _reader.Capabilities.Resolutions[0]);

        if (cr.ResultCode != Constants.ResultCode.DP_SUCCESS || cr.Data is null) return null;
        // Calidad pobre (dedo mal apoyado) → como si no hubiera dedo: se reintenta.
        return cr.Quality == Constants.CaptureQuality.DP_QUALITY_GOOD ? cr.Data : null;
    }, ct);

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
