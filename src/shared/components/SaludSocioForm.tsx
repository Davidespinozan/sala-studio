import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

/**
 * Formulario de salud del socio: antecedentes + contacto de emergencia. Se usa igual
 * en el perfil del socio (edita lo suyo) y en la ficha de recepción (staff edita por
 * cualquiera de su tenant). Lee/escribe `socio_salud` (RLS + RPC guardar_socio_salud).
 * Solo debe montarse cuando el tenant lo pide (config.registro.pide_salud).
 */
interface SaludRow {
  contacto_emergencia_nombre: string;
  contacto_emergencia_tel: string;
  antecedentes_clinicos: string;
  antecedentes_musculoesqueleticos: string;
  tiene_condicion: boolean;
}

const VACIO: SaludRow = {
  contacto_emergencia_nombre: '',
  contacto_emergencia_tel: '',
  antecedentes_clinicos: '',
  antecedentes_musculoesqueleticos: '',
  tiene_condicion: false
};

export function SaludSocioForm({ usuarioId }: { usuarioId: string }) {
  const [row, setRow] = useState<SaludRow>(VACIO);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      // socio_salud aún no está en los tipos generados → cast del builder.
      const q = supabase.from('socio_salud' as never) as unknown as {
        select: (s: string) => {
          eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown }> };
        };
      };
      const { data } = await q
        .select(
          'contacto_emergencia_nombre, contacto_emergencia_tel, antecedentes_clinicos, antecedentes_musculoesqueleticos, tiene_condicion'
        )
        .eq('usuario_id', usuarioId)
        .maybeSingle();
      if (cancel) return;
      if (data) {
        const d = data as Partial<SaludRow>;
        setRow({
          contacto_emergencia_nombre: d.contacto_emergencia_nombre ?? '',
          contacto_emergencia_tel: d.contacto_emergencia_tel ?? '',
          antecedentes_clinicos: d.antecedentes_clinicos ?? '',
          antecedentes_musculoesqueleticos: d.antecedentes_musculoesqueleticos ?? '',
          tiene_condicion: d.tiene_condicion ?? false
        });
      }
      setCargando(false);
    })();
    return () => {
      cancel = true;
    };
  }, [usuarioId]);

  async function guardar() {
    setGuardando(true);
    setMsg(null);
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      name: string,
      args: Record<string, unknown>
    ) => Promise<{ error: { message: string } | null }>;
    const { error } = await rpc('guardar_socio_salud', {
      p_usuario_id: usuarioId,
      p_contacto_nombre: row.contacto_emergencia_nombre,
      p_contacto_tel: row.contacto_emergencia_tel,
      p_antecedentes_clinicos: row.antecedentes_clinicos,
      p_antecedentes_musculo: row.antecedentes_musculoesqueleticos,
      p_tiene_condicion: row.tiene_condicion
    });
    setGuardando(false);
    setMsg(error ? { tipo: 'error', texto: 'No se pudo guardar: ' + error.message } : { tipo: 'ok', texto: 'Guardado ✓' });
  }

  if (cargando) {
    return <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted, var(--sala-text-tertiary))' }}>Cargando…</p>;
  }

  const label: React.CSSProperties = { fontSize: '12px', fontWeight: 600, color: 'var(--sala-text-secondary)', display: 'block', marginBottom: '4px' };
  const campo: React.CSSProperties = { display: 'flex', flexDirection: 'column', marginBottom: '12px' };

  return (
    <div>
      <div style={campo}>
        <label style={label} htmlFor="salud-contacto-nombre">Contacto de emergencia (nombre)</label>
        <input
          id="salud-contacto-nombre"
          className="ek-input"
          value={row.contacto_emergencia_nombre}
          onChange={(e) => setRow((r) => ({ ...r, contacto_emergencia_nombre: e.target.value }))}
          placeholder="Ej. María (mamá)"
        />
      </div>
      <div style={campo}>
        <label style={label} htmlFor="salud-contacto-tel">Contacto de emergencia (teléfono)</label>
        <input
          id="salud-contacto-tel"
          className="ek-input"
          inputMode="tel"
          value={row.contacto_emergencia_tel}
          onChange={(e) => setRow((r) => ({ ...r, contacto_emergencia_tel: e.target.value }))}
          placeholder="Ej. 667 123 4567"
        />
      </div>
      <div style={campo}>
        <label style={label} htmlFor="salud-clinicos">Antecedentes clínicos (enfermedades, cirugía reciente)</label>
        <textarea
          id="salud-clinicos"
          className="ek-input"
          rows={3}
          value={row.antecedentes_clinicos}
          onChange={(e) => setRow((r) => ({ ...r, antecedentes_clinicos: e.target.value }))}
          placeholder="Ej. asma; cirugía de rodilla en 2024"
        />
      </div>
      <div style={campo}>
        <label style={label} htmlFor="salud-musculo">Antecedentes musculoesqueléticos y quirúrgicos</label>
        <textarea
          id="salud-musculo"
          className="ek-input"
          rows={3}
          value={row.antecedentes_musculoesqueleticos}
          onChange={(e) => setRow((r) => ({ ...r, antecedentes_musculoesqueleticos: e.target.value }))}
          placeholder="Ej. lesión lumbar; hombro operado"
        />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer', marginBottom: '14px' }}>
        <input
          type="checkbox"
          checked={row.tiene_condicion}
          onChange={(e) => setRow((r) => ({ ...r, tiene_condicion: e.target.checked }))}
        />
        Tengo una condición o limitación física (para acondicionamiento clínico)
      </label>

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

/** Lee el flag config.registro.pide_salud del tenant (JSON sin tipar). */
export function tenantPideSalud(config: unknown): boolean {
  const c = config as { registro?: { pide_salud?: unknown } } | null;
  return c?.registro?.pide_salud === true;
}
