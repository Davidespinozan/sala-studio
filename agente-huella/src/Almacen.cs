using System.Collections.Concurrent;
using System.Text.Json;

namespace SalaAgente;

/// <summary>Una entrada de check-in que quedó pendiente de subir (estábamos sin internet).</summary>
public sealed record EntradaPendiente(string UsuarioId, DateTimeOffset Momento);

/// <summary>
/// La memoria local del agente. Dos cosas:
///   1) las huellas del gym (para comparar SIN pedirle nada a SALA en cada dedo);
///   2) una cola de entradas que no se pudieron subir (mostrador sin internet).
/// La cola se persiste a disco: si se reinicia la compu, no se pierde una entrada.
/// </summary>
public sealed class Almacen
{
    private volatile IReadOnlyList<HuellaCache> _huellas = [];
    private readonly ConcurrentQueue<EntradaPendiente> _cola = new();
    private readonly string _rutaCola;
    private readonly object _guardarLock = new();

    public Almacen(string carpetaDatos)
    {
        Directory.CreateDirectory(carpetaDatos);
        _rutaCola = Path.Combine(carpetaDatos, "entradas-pendientes.json");
        CargarCola();
    }

    public IReadOnlyList<HuellaCache> Huellas => _huellas;
    public int PendientesCount => _cola.Count;

    /// <summary>Reemplaza el set de huellas (viene de un sync). Convierte base64 → bytes.</summary>
    public void ReemplazarHuellas(IEnumerable<HuellaSync> desdeSync)
    {
        _huellas = desdeSync
            .Select(h => new HuellaCache(h.UsuarioId, h.Dedo, Convert.FromBase64String(h.PlantillaBase64)))
            .ToList();
    }

    /// <summary>Encola una entrada para subir (o reintentar). Persiste al toque.</summary>
    public void Encolar(EntradaPendiente e)
    {
        _cola.Enqueue(e);
        GuardarCola();
    }

    /// <summary>
    /// Reintenta subir todo lo encolado. `subir` sube UNA y devuelve true si lo logró.
    /// Se detiene al primer fallo (probablemente sigue sin internet) para no gastar.
    /// </summary>
    public async Task DrenarAsync(Func<EntradaPendiente, Task<bool>> subir)
    {
        var quedan = new List<EntradaPendiente>();
        var huboCambio = false;

        while (_cola.TryDequeue(out var e))
        {
            if (await subir(e)) { huboCambio = true; continue; }
            quedan.Add(e);   // falló: guardarla y parar
            break;
        }
        // Lo que no se pudo subir vuelve a la cola (preservando orden).
        foreach (var e in quedan) _cola.Enqueue(e);
        while (_cola.TryDequeue(out var resto)) quedan.Add(resto);
        foreach (var e in quedan) _cola.Enqueue(e);

        if (huboCambio || quedan.Count > 0) GuardarCola();
    }

    private void CargarCola()
    {
        if (!File.Exists(_rutaCola)) return;
        try
        {
            var items = JsonSerializer.Deserialize<List<EntradaPendiente>>(File.ReadAllText(_rutaCola)) ?? [];
            foreach (var e in items) _cola.Enqueue(e);
        }
        catch { /* archivo corrupto: se ignora, no vale tumbar el agente por la cola */ }
    }

    private void GuardarCola()
    {
        lock (_guardarLock)
        {
            try { File.WriteAllText(_rutaCola, JsonSerializer.Serialize(_cola.ToArray())); }
            catch { /* disco lleno / permisos: seguimos en memoria */ }
        }
    }
}
