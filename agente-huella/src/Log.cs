namespace SalaAgente;

/// <summary>
/// Log a archivo, al lado del .exe (<c>sala-agente.log</c>). Best-effort: si no
/// puede escribir, no rompe nada. Sirve para diagnosticar el lector EN la compu
/// del gym sin depender del tooltip de la bandeja: cada captura deja su rastro
/// (ResultCode/Quality del SDK), que es justo lo que no se ve desde afuera.
/// </summary>
public static class Log
{
    private static readonly string Ruta =
        Path.Combine(AppContext.BaseDirectory, "sala-agente.log");
    private static readonly object Candado = new();

    public static void Escribir(string msg)
    {
        try
        {
            lock (Candado)
                File.AppendAllText(Ruta,
                    $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff}  {msg}{Environment.NewLine}");
        }
        catch { /* si no se puede loguear, ni modo: nunca tumbar el agente por esto */ }
    }
}
