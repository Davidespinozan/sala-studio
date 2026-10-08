import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone } from '@shared/lib/timezone';
import { formatInTimeZone } from 'date-fns-tz';
import { es } from 'date-fns/locale';

interface Movimiento {
  id: string;
  tipo: string;
  delta_creditos: number;
  motivo: string | null;
  created_at: string;
  created_by: string | null;
  autor: { nombre: string | null; rol: string | null } | null;
}

const TIPO_LABEL: Record<string, string> = {
  alta: 'Alta / renovación',
  debito: 'Reserva',
  devolucion: 'Devolución',
  expiracion: 'Vencimiento',
  ajuste: 'Ajuste',
  no_show: 'No asistió'
};

/** Motivo técnico ('renovacion_desde_hoy — tier paq-12') → texto legible. */
function motivoLegible(m: string | null): string {
  if (!m) return '';
  return m
    .replace(/^renovacion_desde_hoy\b/, 'Renovación (desde hoy)')
    .replace(/^renovacion\b/, 'Renovación')
    .replace(/^cambio_de_tipo\b/, 'Cambio de plan')
    .replace(/^alta\b/, 'Alta')
    .replace(/ — tier /, ' · ');
}

/**
 * Movimientos del plan del socio (membresia_movimientos): altas, renovaciones,
 * reservas, ajustes, con quién lo hizo. Sirve para ver de un vistazo una doble
 * renovación (caso Annie / The Core: dos altas de +12 el mismo día). RLS: el
 * socio ve los suyos; recepción/admin los del tenant.
 */
export function MovimientosPlan({ usuarioId, reloadKey = 0, limite = 12 }: { usuarioId: string; reloadKey?: number; limite?: number }) {
  const tz = getTenantTimezone(useTenant());
  const [movs, setMovs] = useState<Movimiento[] | null>(null);
  const [verTodos, setVerTodos] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data: mems } = await supabase.from('membresias').select('id').eq('usuario_id', usuarioId);
      const ids = (mems ?? []).map((m) => m.id);
      if (ids.length === 0) {
        if (!cancel) setMovs([]);
        return;
      }
      const { data } = await supabase
        .from('membresia_movimientos')
        .select('id, tipo, delta_creditos, motivo, created_at, created_by')
        .in('membresia_id', ids)
        .order('created_at', { ascending: false })
        .limit(100);
      const rows = (data ?? []) as Omit<Movimiento, 'autor'>[];
      // created_by no tiene FK a usuarios en la base (no hay embed): los autores
      // se resuelven en una segunda consulta.
      const autorIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))] as string[];
      const autores = new Map<string, { nombre: string | null; rol: string | null }>();
      if (autorIds.length > 0) {
        const { data: us } = await supabase.from('usuarios').select('id, nombre, rol').in('id', autorIds);
        for (const u of us ?? []) autores.set(u.id, { nombre: u.nombre, rol: u.rol });
      }
      if (!cancel) {
        setMovs(rows.map((r) => ({ ...r, autor: r.created_by ? autores.get(r.created_by) ?? { nombre: null, rol: null } : null })));
      }
    })();
    return () => { cancel = true; };
  }, [usuarioId, reloadKey]);

  if (movs === null) return <div className="ek-skeleton" style={{ height: '60px', borderRadius: '12px' }} />;
  if (movs.length === 0) {
    return <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: 0 }}>Sin movimientos todavía.</p>;
  }

  const visibles = verTodos ? movs : movs.slice(0, limite);

  return (
    <div>
      <div style={{ display: 'grid', gap: '8px' }}>
        {visibles.map((m) => {
          const delta = m.delta_creditos;
          // Quién: staff con nombre; si lo hizo el propio socio desde la app, "App";
          // sin autor = proceso automático (vencimiento, no-show).
          const quien = !m.autor ? 'Automático' : m.autor.rol === 'miembro' ? 'App del socio' : (m.autor.nombre ?? 'Staff');
          return (
            <div key={m.id} style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
              <span
                style={{
                  flexShrink: 0, minWidth: '34px', textAlign: 'right',
                  fontWeight: 800, fontSize: '13px', fontVariantNumeric: 'tabular-nums',
                  color: delta > 0 ? 'var(--sala-primary)' : delta < 0 ? 'var(--sala-text-secondary)' : 'var(--sala-text-tertiary)'
                }}
              >
                {delta > 0 ? `+${delta}` : delta === 0 ? '·' : delta}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>
                  {TIPO_LABEL[m.tipo] ?? m.tipo}
                  {m.motivo && (
                    <span style={{ fontWeight: 400, color: 'var(--sala-text-secondary)' }}> · {motivoLegible(m.motivo)}</span>
                  )}
                </p>
                <p style={{ margin: '1px 0 0', fontSize: '11.5px', color: 'var(--sala-text-tertiary)' }}>
                  {formatInTimeZone(new Date(m.created_at), tz, "d MMM yyyy · HH:mm", { locale: es })} · {quien}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      {movs.length > limite && (
        <button
          type="button"
          onClick={() => setVerTodos((v) => !v)}
          style={{ marginTop: '10px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600, color: 'var(--sala-primary)' }}
        >
          {verTodos ? 'Ver menos' : `Ver todos (${movs.length})`}
        </button>
      )}
    </div>
  );
}
