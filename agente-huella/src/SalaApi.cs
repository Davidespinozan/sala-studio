using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace SalaAgente;

// ── Formas EXACTAS que devuelven/esperan los endpoints de SALA ──────────────

/// <summary>Una huella del gym, ya descifrada, lista para comparar local.</summary>
public sealed record HuellaSync(
    [property: JsonPropertyName("usuario_id")] string UsuarioId,
    [property: JsonPropertyName("dedo")] string Dedo,
    [property: JsonPropertyName("formato")] string Formato,
    [property: JsonPropertyName("plantilla")] string PlantillaBase64);

public sealed record SyncResp(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("huellas")] List<HuellaSync> Huellas);

/// <summary>Respuesta de "¿hay alguien esperando para poner el dedo?".</summary>
public sealed record PendienteResp(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("pendiente")] bool Pendiente,
    [property: JsonPropertyName("enrolamiento_id")] string? EnrolamientoId,
    [property: JsonPropertyName("dedo")] string? Dedo,
    [property: JsonPropertyName("socio")] string? Socio);

/// <summary>Error uniforme que devuelven los endpoints: { ok:false, codigo, mensaje }.</summary>
public sealed record ErrorResp(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("codigo")] string? Codigo,
    [property: JsonPropertyName("mensaje")] string? Mensaje);

public sealed record CheckinResp(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("mensaje")] string? Mensaje,
    [property: JsonPropertyName("clase")] string? Clase,
    [property: JsonPropertyName("hora")] string? Hora);

/// <summary>
/// Cliente HTTP del agente. Encapsula los 4 llamados y NADA más: el agente no
/// tiene otra puerta a SALA. El token viaja en cada request (así lo espera el
/// backend, que lo hashea para identificar el lector).
/// </summary>
public sealed class SalaApi(Config cfg)
{
    private readonly HttpClient _http = new()
    {
        BaseAddress = new Uri(cfg.ApiBase.TrimEnd('/') + "/"),
        Timeout = TimeSpan.FromSeconds(20)
    };
    private readonly string _token = cfg.Token;

    /// <summary>Baja las huellas del gym (descifradas) para comparar local.</summary>
    public async Task<List<HuellaSync>> SyncAsync(CancellationToken ct = default)
    {
        var resp = await _http.PostAsJsonAsync("huella-agente",
            new { accion = "sync", token = _token }, ct);
        await LanzarSiError(resp, ct);
        var body = await resp.Content.ReadFromJsonAsync<SyncResp>(ct);
        return body?.Huellas ?? [];
    }

    /// <summary>¿Recepción abrió una toma de huella? Devuelve null si no.</summary>
    public async Task<PendienteResp?> PendienteAsync(CancellationToken ct = default)
    {
        var resp = await _http.PostAsJsonAsync("huella-agente",
            new { accion = "pendiente", token = _token }, ct);
        await LanzarSiError(resp, ct);
        var body = await resp.Content.ReadFromJsonAsync<PendienteResp>(ct);
        return body is { Pendiente: true } ? body : null;
    }

    /// <summary>Cierra la toma subiendo la plantilla ISO capturada (base64).</summary>
    public async Task EnrolarAsync(string enrolamientoId, string plantillaBase64, int calidad, CancellationToken ct = default)
    {
        var resp = await _http.PostAsJsonAsync("huella-agente", new
        {
            accion = "enrolar",
            token = _token,
            enrolamiento_id = enrolamientoId,
            plantilla = plantillaBase64,
            formato = "iso19794-2",
            calidad
        }, ct);
        await LanzarSiError(resp, ct);
    }

    /// <summary>El socio apoyó el dedo y el matching local dio positivo → registrar entrada.</summary>
    public async Task<CheckinResp> CheckInAsync(string usuarioId, DateTimeOffset momento, CancellationToken ct = default)
    {
        var resp = await _http.PostAsJsonAsync("checkin-lector", new
        {
            token = _token,
            usuario_id = usuarioId,
            momento = momento.ToUniversalTime().ToString("o")
        }, ct);
        await LanzarSiError(resp, ct);
        return await resp.Content.ReadFromJsonAsync<CheckinResp>(ct)
               ?? new CheckinResp(true, null, null, null);
    }

    /// <summary>
    /// Convierte una respuesta de error de SALA en una excepción legible. Distingue
    /// el token malo (401 LECTOR_*) para que el agente avise "lector no autorizado"
    /// en vez de reintentar en vano.
    /// </summary>
    private static async Task LanzarSiError(HttpResponseMessage resp, CancellationToken ct)
    {
        if (resp.IsSuccessStatusCode) return;
        ErrorResp? err = null;
        try { err = await resp.Content.ReadFromJsonAsync<ErrorResp>(ct); } catch { /* cuerpo no-JSON */ }

        var codigo = err?.Codigo ?? "";
        var msg = err?.Mensaje ?? resp.ReasonPhrase ?? "error";
        if ((int)resp.StatusCode == 401 || codigo.Contains("LECTOR_"))
            throw new LectorNoAutorizadoException($"{codigo} {msg}".Trim());
        throw new HttpRequestException($"SALA respondió {(int)resp.StatusCode}: {codigo} {msg}".Trim());
    }
}

/// <summary>Token del lector inválido/desactivado: no tiene sentido reintentar.</summary>
public sealed class LectorNoAutorizadoException(string msg) : Exception(msg);
