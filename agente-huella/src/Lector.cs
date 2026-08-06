namespace SalaAgente;

/// <summary>Una captura lista: la plantilla en formato ISO 19794-2 + su calidad (0-100).</summary>
public sealed record Captura(byte[] PlantillaIso, int Calidad);

/// <summary>
/// La ÚNICA interfaz específica por marca de lector. El núcleo del agente solo
/// conoce esto — capturar un dedo y devolver una plantilla ISO estándar. Sumar
/// otra marca (ZKTeco, SecuGen…) = implementar esta interfaz, nada más.
/// </summary>
public interface ILectorHuella : IDisposable
{
    /// <summary>Nombre del lector conectado (para logs / diagnóstico).</summary>
    string Nombre { get; }

    /// <summary>Abre el lector. Lanza si no hay ninguno conectado.</summary>
    void Abrir();

    /// <summary>
    /// Espera a que se apoye UN dedo y devuelve su plantilla ISO. Devuelve null si
    /// pasó el timeout sin dedo (para poder volver al loop y revisar pendientes).
    /// </summary>
    Task<Captura?> CapturarUnaAsync(TimeSpan timeout, CancellationToken ct);

    /// <summary>
    /// Enrolamiento robusto: junta varias tomas del MISMO dedo en una sola
    /// plantilla ISO de mejor calidad. Devuelve null si se canceló/expiró.
    /// <paramref name="onAvance"/> se llama con cuántas tomas buenas van (1..N) para
    /// que la bandeja muestre el progreso y no parezca trabado.
    /// </summary>
    Task<Captura?> EnrolarAsync(Action<int>? onAvance, CancellationToken ct);
}

/// <summary>
/// Motor de comparación. Recibe plantillas ISO (de cualquier lector) y decide si
/// son la misma persona. Separado del lector a propósito: si dos marcas exportan
/// ISO, comparten el mismo matcher.
/// </summary>
public interface IMatcher
{
    /// <summary>true si la captura corresponde a alguna huella guardada del gym.</summary>
    string? Identificar(byte[] capturaIso, IReadOnlyList<HuellaCache> candidatas);
}

/// <summary>Una huella del gym cacheada localmente (viene del sync).</summary>
public sealed record HuellaCache(string UsuarioId, string Dedo, byte[] PlantillaIso);
