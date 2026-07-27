using System.Text.Json;
using System.Text.Json.Serialization;

namespace SalaAgente;

/// <summary>
/// Configuración del agente. Vive en `sala-lector.config.json` junto al .exe.
/// En la distribución auto-servicio, SALA la genera con el token ya adentro.
/// </summary>
public sealed class Config
{
    [JsonPropertyName("apiBase")]
    public string ApiBase { get; set; } = "https://www.salastudio.app/.netlify/functions";

    [JsonPropertyName("token")]
    public string Token { get; set; } = "";

    /// <summary>Cada cuánto se re-bajan las huellas del gym (segundos).</summary>
    [JsonPropertyName("syncCadaSegundos")]
    public int SyncCadaSegundos { get; set; } = 60;

    /// <summary>Cada cuánto se pregunta si hay una toma de huella abierta (segundos).</summary>
    [JsonPropertyName("pendienteCadaSegundos")]
    public int PendienteCadaSegundos { get; set; } = 2;

    /// <summary>
    /// Umbral de match del motor de DigitalPersona. El score es una PROBABILIDAD de
    /// falso positivo: mientras MÁS BAJO, más estricto. 0x14 * PROBABILITY_ONE/100000
    /// ≈ 1 en 100.000 es el valor recomendado por el SDK (21474). Subirlo acepta más
    /// (más falsos positivos); bajarlo rechaza más.
    /// </summary>
    [JsonPropertyName("umbralMatch")]
    public int UmbralMatch { get; set; } = 21474;

    private static readonly JsonSerializerOptions Opts = new() { WriteIndented = true };

    /// <summary>Lee el config del lado del .exe. Si no existe, lo crea vacío y avisa.</summary>
    public static Config Cargar(string ruta)
    {
        if (!File.Exists(ruta))
        {
            var vacia = new Config();
            File.WriteAllText(ruta, JsonSerializer.Serialize(vacia, Opts));
            throw new InvalidOperationException(
                $"Falta la configuración. Se creó '{ruta}': pon ahí el TOKEN del lector " +
                "(Admin → Lectores) y vuelve a abrir el agente.");
        }

        var cfg = JsonSerializer.Deserialize<Config>(File.ReadAllText(ruta))
                  ?? throw new InvalidOperationException($"'{ruta}' no es un JSON válido.");

        if (string.IsNullOrWhiteSpace(cfg.Token))
            throw new InvalidOperationException(
                $"'{ruta}' no tiene token. Cópialo de Admin → Lectores.");

        return cfg;
    }
}
