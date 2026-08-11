import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cake } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone, hoyEnTimezone } from '@shared/lib/timezone';
import { Avatar } from '@shared/components/Avatar';

interface Cumpleanero {
  usuarioId: string;
  nombre: string;
  avatarUrl: string | null;
  /** 0 = hoy, 1..7 = próximos días. */
  diasFaltan: number;
  /** Edad que cumple (no la actual). */
  edadQueCumple: number;
  /** Fecha del cumpleaños este año, 'YYYY-MM-DD'. */
  fecha: string;
}

const DIA_MS = 86400000;

/** Próximo cumpleaños a partir de HOY (calendario del gym). 29-feb rueda a 1-mar. */
function proximoCumple(fechaNacimiento: string, hoyISO: string): { diasFaltan: number; edad: number; fecha: string } | null {
  const [ny, nm, nd] = fechaNacimiento.split('-').map(Number);
  const [hy, hm, hd] = hoyISO.split('-').map(Number);
  if (!ny || !nm || !nd) return null;
  const hoyUTC = Date.UTC(hy, hm - 1, hd);
  let objetivo = Date.UTC(hy, nm - 1, nd);
  if (objetivo < hoyUTC) objetivo = Date.UTC(hy + 1, nm - 1, nd);
  const dias = Math.round((objetivo - hoyUTC) / DIA_MS);
  const d = new Date(objetivo);
  const fecha = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { diasFaltan: dias, edad: d.getUTCFullYear() - ny, fecha };
}

function etiquetaDia(fecha: string, diasFaltan: number): string {
  if (diasFaltan === 0) return '¡Hoy!';
  if (diasFaltan === 1) return 'Mañana';
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
  });
}

/**
 * Cumpleañeros de hoy y de los próximos 7 días (socios activos con fecha de
 * nacimiento en la ficha). Para que el staff prepare su detalle: la felicitación
 * al socio ya sale sola por push. No se muestra si no hay ninguno.
 */
export function CumpleanosCard({ linkBase }: { linkBase: string }) {
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const [lista, setLista] = useState<Cumpleanero[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // usuarios_datos_privados aún no está en los tipos generados → cast.
      const { data, error } = await (supabase as any)
        .from('usuarios_datos_privados')
        .select('fecha_nacimiento, usuario:usuarios!usuarios_datos_privados_usuario_id_fkey(id, nombre, status, rol, avatar_url)')
        .eq('tenant_id', tenant.id)
        .not('fecha_nacimiento', 'is', null);
      if (cancelled) return;
      if (error) {
        console.error('[CumpleanosCard]', error);
        return;
      }
      const hoyISO = hoyEnTimezone(tz);
      const rows = (data ?? []) as {
        fecha_nacimiento: string;
        usuario: { id: string; nombre: string | null; status: string; rol: string; avatar_url: string | null } | null;
      }[];
      const proximos: Cumpleanero[] = [];
      for (const r of rows) {
        const u = r.usuario;
        if (!u || u.rol !== 'miembro' || u.status !== 'activo') continue;
        const p = proximoCumple(r.fecha_nacimiento, hoyISO);
        if (!p || p.diasFaltan > 7) continue;
        proximos.push({
          usuarioId: u.id,
          nombre: u.nombre ?? '—',
          avatarUrl: u.avatar_url,
          diasFaltan: p.diasFaltan,
          edadQueCumple: p.edad,
          fecha: p.fecha
        });
      }
      proximos.sort((a, b) => a.diasFaltan - b.diasFaltan || a.nombre.localeCompare(b.nombre));
      setLista(proximos);
    })();
    return () => { cancelled = true; };
  }, [tenant.id, tz]);

  if (lista.length === 0) return null;

  const hoy = lista.filter((c) => c.diasFaltan === 0);
  const semana = lista.filter((c) => c.diasFaltan > 0);

  return (
    <section className="ek-card" style={{ padding: '20px', marginBottom: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
        <Cake size={16} style={{ color: 'var(--ek-mustard)' }} aria-hidden />
        <span className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px' }}>CUMPLEAÑOS</span>
      </div>

      <div style={{ display: 'grid', gap: '10px' }}>
        {hoy.map((c) => (
          <Fila key={c.usuarioId} c={c} linkBase={linkBase} destacado />
        ))}
        {semana.map((c) => (
          <Fila key={c.usuarioId} c={c} linkBase={linkBase} />
        ))}
      </div>
    </section>
  );
}

function Fila({ c, linkBase, destacado = false }: { c: Cumpleanero; linkBase: string; destacado?: boolean }) {
  return (
    <Link
      to={`${linkBase}/${c.usuarioId}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: destacado ? '10px 12px' : '2px 0',
        borderRadius: '10px',
        background: destacado ? 'var(--sala-primary-light)' : 'transparent',
        textDecoration: 'none'
      }}
    >
      <Avatar src={c.avatarUrl} nombre={c.nombre} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: destacado ? 700 : 600, color: 'var(--ek-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.nombre}
        </p>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ek-ink-muted)' }}>
          Cumple {c.edadQueCumple} años
        </p>
      </div>
      <span
        style={{
          fontSize: '12px',
          fontWeight: destacado ? 700 : 500,
          color: destacado ? 'var(--sala-primary)' : 'var(--ek-ink-muted)',
          whiteSpace: 'nowrap'
        }}
      >
        {etiquetaDia(c.fecha, c.diasFaltan)}
      </span>
    </Link>
  );
}