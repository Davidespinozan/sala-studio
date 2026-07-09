import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { usePendientes } from '../hooks/usePendientes';

interface Item {
  count: number;
  titulo: string;
  desc: string;
  to: string;
  color: string;
  bg: string;
}

/**
 * Centro de pendientes: inbox operativo del dashboard admin. Muestra lo que
 * requiere atención (pagos pendientes, socios bloqueados, no-shows recientes),
 * cada uno enruta a dónde se resuelve. "Todo al día" si no hay nada.
 */
export default function CentroPendientes() {
  const { data, isLoading } = usePendientes();

  if (isLoading) return null;

  const items: Item[] = [
    {
      count: data.pendientePago,
      titulo: 'Pagos pendientes',
      desc: 'Socios que se registraron y todavía no pagaron.',
      to: '/admin/miembros?status=pendiente_pago',
      color: 'var(--ek-danger)',
      bg: 'var(--ek-danger-soft)'
    },
    {
      count: data.bloqueados,
      titulo: 'Socios bloqueados',
      desc: 'Acceso bloqueado por no-shows. Revisá si corresponde.',
      to: '/admin/miembros',
      color: 'var(--ek-mustard)',
      bg: 'var(--ek-mustard-soft)'
    },
    {
      count: data.noShows7d,
      titulo: 'No-shows (7 días)',
      desc: 'Reservas no asistidas esta semana.',
      to: '/admin/reportes',
      color: 'var(--sala-text-secondary)',
      bg: 'var(--ek-bg-elevated)'
    }
  ];

  const activos = items.filter((i) => i.count > 0);

  return (
    <section className="ek-card" style={{ padding: '24px', marginBottom: '32px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px', marginBottom: '2px' }}>
        PENDIENTES
      </p>
      <h2
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '22px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          margin: 0,
          marginBottom: activos.length ? '20px' : '4px'
        }}
      >
        {activos.length ? 'Requiere tu atención' : 'Todo al día'}
      </h2>

      {activos.length === 0 ? (
        <p style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
          <CheckCircle2 size={16} strokeWidth={2.25} style={{ color: 'var(--ek-success)' }} />
          No hay nada pendiente por ahora.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {activos.map((it) => (
            <Link
              key={it.titulo}
              to={it.to}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                padding: '12px 14px',
                borderRadius: '12px',
                textDecoration: 'none',
                color: 'inherit',
                background: 'var(--ek-bg-soft)'
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  minWidth: '32px',
                  height: '32px',
                  padding: '0 9px',
                  borderRadius: '999px',
                  background: it.bg,
                  color: it.color,
                  fontSize: '14px',
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                {it.count}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: '14px', fontWeight: 600, margin: 0, color: 'var(--ek-ink)' }}>
                  {it.titulo}
                </p>
                <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '2px 0 0' }}>
                  {it.desc}
                </p>
              </div>
              <ArrowRight size={16} strokeWidth={2.5} style={{ color: 'var(--ek-ink-faint)', flexShrink: 0 }} />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
