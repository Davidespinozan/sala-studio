import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { actualizarPerfilSocio } from '@shared/lib/datosSocio';

/**
 * Formulario "Completa tu perfil" del socio: teléfono (obligatorio), fecha de
 * nacimiento (obligatorio), sexo y domicilio (opcionales). Lee la ficha privada
 * con la policy SELECT del socio y guarda con el RPC socio_actualizar_perfil.
 * Molde: SaludSocioForm.
 */
interface Props {
  usuarioId: string;
  telefonoInicial?: string | null;
  /** Se llama tras guardar OK (el padre refresca el usuario para ocultar el banner). */
  onSaved?: () => void;
}

export function CompletarPerfilForm({ usuarioId, telefonoInicial, onSaved }: Props) {
  const [telefono, setTelefono] = useState(telefonoInicial ?? '');
  const [fechaNac, setFechaNac] = useState('');
  const [sexo, setSexo] = useState('');
  const [domicilio, setDomicilio] = useState('');
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      // usuarios_datos_privados aún no está en los tipos generados → cast del builder.
      const q = supabase.from('usuarios_datos_privados' as never) as unknown as {
        select: (s: string) => {
          eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown }> };
        };
      };
      const { data } = await q
        .select('fecha_nacimiento, sexo, domicilio')
        .eq('usuario_id', usuarioId)
        .maybeSingle();
      if (cancel) return;
      if (data) {
        const d = data as { fecha_nacimiento?: string | null; sexo?: string | null; domicilio?: string | null };
        setFechaNac(d.fecha_nacimiento ?? '');
        setSexo(d.sexo ?? '');
        setDomicilio(d.domicilio ?? '');
      }
      setCargando(false);
    })();
    return () => { cancel = true; };
  }, [usuarioId]);

  async function guardar() {
    if (!telefono.trim()) { setMsg({ tipo: 'error', texto: 'Pon tu teléfono / WhatsApp.' }); return; }
    if (!fechaNac) { setMsg({ tipo: 'error', texto: 'Pon tu fecha de nacimiento.' }); return; }
    setGuardando(true);
    setMsg(null);
    const { error } = await actualizarPerfilSocio({
      telefono,
      fecha_nacimiento: fechaNac,
      sexo: sexo || null,
      domicilio: domicilio || null
    });
    setGuardando(false);
    if (error) {
      setMsg({ tipo: 'error', texto: 'No se pudo guardar: ' + error });
      return;
    }
    setMsg({ tipo: 'ok', texto: 'Guardado ✓' });
    onSaved?.();
  }

  if (cargando) {
    return <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)' }}>Cargando…</p>;
  }

  const label: React.CSSProperties = { fontSize: '12px', fontWeight: 600, color: 'var(--sala-text-secondary)', display: 'block', marginBottom: '4px' };
  const campo: React.CSSProperties = { display: 'flex', flexDirection: 'column', marginBottom: '12px' };

  return (
    <div>
      <div style={campo}>
        <label style={label} htmlFor="perfil-tel">Teléfono / WhatsApp</label>
        <input
          id="perfil-tel"
          className="ek-input"
          inputMode="tel"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          placeholder="Ej. 667 123 4567"
        />
      </div>
      <div style={campo}>
        <label style={label} htmlFor="perfil-nac">Fecha de nacimiento</label>
        <input
          id="perfil-nac"
          type="date"
          className="ek-input"
          value={fechaNac}
          onChange={(e) => setFechaNac(e.target.value)}
        />
      </div>
      <div style={campo}>
        <label style={label} htmlFor="perfil-sexo">Sexo (opcional)</label>
        <select id="perfil-sexo" className="ek-input" value={sexo} onChange={(e) => setSexo(e.target.value)}>
          <option value="">Prefiero no decir</option>
          <option value="femenino">Femenino</option>
          <option value="masculino">Masculino</option>
          <option value="otro">Otro</option>
        </select>
      </div>
      <div style={campo}>
        <label style={label} htmlFor="perfil-domicilio">Domicilio (opcional)</label>
        <input
          id="perfil-domicilio"
          className="ek-input"
          value={domicilio}
          onChange={(e) => setDomicilio(e.target.value)}
          placeholder="Calle, número, colonia, ciudad"
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button type="button" onClick={guardar} disabled={guardando} className="ek-cta">
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
        {msg && (
          <span style={{ fontSize: '12.5px', color: msg.tipo === 'ok' ? 'var(--ek-success)' : 'var(--ek-danger)' }}>
            {msg.texto}
          </span>
        )}
      </div>
    </div>
  );
}
