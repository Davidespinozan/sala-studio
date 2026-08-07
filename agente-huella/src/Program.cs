using System.Windows.Forms;

namespace SalaAgente;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
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

        // Arrancar el lector una vez que el message pump YA corre. El streaming del
        // SDK entrega On_Captured por el pump del hilo de UI: si abriéramos el lector
        // aquí (el pump aún no arranca hasta Application.Run), los eventos del dedo no
        // llegarían. Un Timer de WinForms dispara su Tick en el hilo de UI cuando el
        // pump ya está activo → ahí abrimos el lector.
        var arranque = new System.Windows.Forms.Timer { Interval = 250 };
        arranque.Tick += (_, _) =>
        {
            arranque.Stop();
            arranque.Dispose();
            _agente.Iniciar();
        };
        arranque.Start();
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
