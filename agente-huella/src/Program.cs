using System.Windows.Forms;
using Microsoft.Win32;

namespace SalaAgente;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        RegistrarAutoArranque();
        try
        {
            var cfg = Config.Cargar(Path.Combine(AppContext.BaseDirectory, "sala-lector.config.json"));
            var datos = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SalaAgente");
            using var ctx = new BandejaContext(new Agente(cfg, datos));
            Application.Run(ctx);
        }
        catch (Exception ex)
        {
            // Config faltante o token vacío: se le dice al usuario en cristiano y se sale.
            MessageBox.Show(ex.Message, "Agente SALA — no pudo arrancar",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    /// <summary>
    /// El agente se configura para arrancar SOLO con Windows (al iniciar sesión el
    /// usuario del mostrador). Así, tras encender la compu, ya está corriendo sin que
    /// nadie abra nada — como el sistema anterior. Se hace por DOS vías, porque en
    /// algunas PCs Windows ignora la del registro:
    ///   1) HKCU\...\Run (rápida, pero no siempre confiable).
    ///   2) Un acceso directo en la carpeta de Inicio del usuario — el mismo
    ///      mecanismo del sistema anterior, que Windows SIEMPRE respeta al iniciar
    ///      sesión. Esta es la que de verdad garantiza el arranque.
    /// Ambas son idempotentes: reapuntan al .exe actual cada vez (por si lo movieron).
    /// No requieren admin (todo va en el perfil del usuario). Si algo falla, no es
    /// fatal: el agente corre igual.
    /// </summary>
    static void RegistrarAutoArranque()
    {
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe)) return;
        var dir = Path.GetDirectoryName(exe) ?? "";

        // Vía 1: registro HKCU\...\Run. Barata, pero hay PCs donde Windows no la
        // dispara; por eso ya no dependemos solo de esto.
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
            key?.SetValue("SalaAgente", $"\"{exe}\"");
        }
        catch { /* no es fatal */ }

        // Vía 2 (la confiable): un acceso directo (.lnk) en la carpeta de Inicio.
        // Windows lo lanza al iniciar sesión, siempre. WorkingDirectory = la carpeta
        // del .exe para que encuentre sus DLLs y el config. Se crea con WScript.Shell
        // (COM estándar de Windows), sin dependencias extra.
        try
        {
            var inicio = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            if (!string.IsNullOrEmpty(inicio))
            {
                var lnk = Path.Combine(inicio, "SalaAgente.lnk");
                var tipo = Type.GetTypeFromProgID("WScript.Shell");
                if (tipo != null)
                {
                    dynamic shell = Activator.CreateInstance(tipo)!;
                    var sc = shell.CreateShortcut(lnk);
                    sc.TargetPath = exe;
                    sc.WorkingDirectory = dir;
                    sc.Description = "Agente de huella SALA";
                    sc.Save();
                }
            }
        }
        catch { /* si no se pudo crear el acceso directo, no es fatal */ }
    }
}

/// <summary>
/// El agente vive en la BANDEJA (junto al reloj), sin ventana. El icono muestra el
/// último estado al pasar el mouse, y el menú permite salir.
/// </summary>
sealed class BandejaContext : ApplicationContext
{
    private readonly NotifyIcon _icono;
    private readonly Agente _agente;

    public BandejaContext(Agente agente)
    {
        _agente = agente;

        var menu = new ContextMenuStrip();
        menu.Items.Add("Salir", null, (_, _) => Salir());

        _icono = new NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Shield,
            Visible = true,
            Text = "Agente SALA — iniciando…",
            ContextMenuStrip = menu
        };

        _agente.Estado += MostrarEstado;
        _agente.Iniciar();
    }

    private void MostrarEstado(string s)
    {
        // El tooltip del NotifyIcon tiene tope de 63 caracteres.
        var t = $"SALA: {s}";
        if (_icono is { }) _icono.Text = t.Length > 63 ? t[..63] : t;
    }

    private void Salir()
    {
        _icono.Visible = false;
        _agente.Dispose();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _icono.Dispose();
        base.Dispose(disposing);
    }
}
