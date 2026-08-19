using System.Windows.Forms;
using Microsoft.Win32;

namespace SalaAgente;

static class Program
{
    // Mantiene viva la señal de "instancia única" durante toda la ejecución.
    private static Mutex? _instancia;

    [STAThread]
    static void Main()
    {
        // Un solo agente a la vez: si ya hay uno corriendo (p. ej. porque el arranque
        // se disparó por dos vías, o alguien abrió el .exe teniéndolo ya arriba), este
        // segundo se sale sin ruido. Así nunca hay dos peleándose por el lector, que
        // se abre en modo EXCLUSIVO.
        _instancia = new Mutex(initiallyOwned: true, @"Local\SalaAgenteInstanciaUnica", out bool esNueva);
        if (!esNueva) return;

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
    /// nadie abra nada — como el sistema anterior. El v8 lo intentaba por el registro
    /// (HKCU\...\Run), pero hay PCs donde Windows lo IGNORA (confirmado en la de numa).
    /// Por eso el v9 borra esa vía vieja y usa la CONFIABLE: un acceso directo en la
    /// carpeta de Inicio del usuario — el mismo mecanismo del sistema anterior, que
    /// Windows siempre respeta al iniciar sesión. Idempotente: reapunta al .exe actual
    /// cada vez (por si lo movieron). No requiere admin (va en el perfil del usuario).
    /// Si algo falla, no es fatal: el agente corre igual.
    /// </summary>
    static void RegistrarAutoArranque()
    {
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe)) return;
        var dir = Path.GetDirectoryName(exe) ?? "";

        // Limpiamos la vía VIEJA (registro HKCU\...\Run) que usaba el v8: en algunas
        // PCs no se dispara (la de numa entre ellas) y, si conviviera con el acceso
        // directo, podría abrir el agente dos veces. La borramos y nos quedamos solo
        // con el acceso directo, que es el método que sí funciona en esa compu.
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
            key?.DeleteValue("SalaAgente", throwOnMissingValue: false);
        }
        catch { /* no es fatal */ }

        // La vía CONFIABLE: un acceso directo (.lnk) en la carpeta de Inicio — el
        // mismo mecanismo del sistema anterior, que Windows siempre respeta al entrar.
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
