import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

export default function Estudios() {
  const tenant = useTenant();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('recursos')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('nombre');

      if (!mounted) return;
      if (error) console.error('[Estudios]', error);
      else setRecursos(data ?? []);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id]);

  if (isLoading) {
    return (
      <div className="ek-container">
        <div className="ek-skeleton" style={{ height: '400px', borderRadius: 'var(--ek-r-card)' }} />
      </div>
    );
  }

  return (
    <div className="ek-container">
      <div style={{ marginBottom: '24px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>EXPLORAR</p>
        <h1 className="ek-display-xl">Nuestros estudios</h1>
        <p className="ek-body-muted" style={{ marginTop: '8px' }}>
          Espacios profesionales diseñados para creadores. Cada uno con su personalidad.
        </p>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '16px'
      }}>
        {recursos.map((r) => {
          const esPro = r.tiers_permitidos.length === 1 && r.tiers_permitidos[0] === 'pro';
          const tiposContenido = r.tipo_contenido ?? [];
          return (
            <Link
              key={r.id}
              to={`/app/estudios/${r.slug}`}
              className="ek-card ek-card-interactive"
              style={{
                padding: 0,
                overflow: 'hidden',
                textDecoration: 'none',
                color: 'inherit',
                borderRadius: 'var(--ek-r-md)'
              }}
            >
              <div style={{
                background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
                aspectRatio: '16 / 10',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                {r.foto_url ? (
                  <img
                    src={r.foto_url}
                    alt={r.nombre}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover'
                    }}
                  />
                ) : (
                  <span style={{
                    fontSize: '10px',
                    color: 'var(--ek-ink-faint)',
                    letterSpacing: '0.18em',
                    fontWeight: 600
                  }}>FOTO PRÓXIMAMENTE</span>
                )}

                <span
                  className={esPro ? 'ek-badge ek-badge--outline' : 'ek-badge'}
                  style={{ position: 'absolute', top: '12px', left: '12px' }}
                >
                  {esPro ? '★ PRO' : 'BÁSICA'}
                </span>
              </div>

              <div style={{ padding: '18px' }}>
                <h3 style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '20px',
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  margin: 0,
                  marginBottom: '6px'
                }}>{r.nombre}</h3>

                {r.descripcion && (
                  <p style={{
                    fontSize: '13px',
                    color: 'var(--ek-ink-muted)',
                    margin: 0,
                    marginBottom: '14px',
                    lineHeight: 1.4
                  }}>{r.descripcion}</p>
                )}

                {tiposContenido.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' }}>
                    {tiposContenido.slice(0, 3).map((tipo) => (
                      <span key={tipo} className="ek-badge ek-badge--neutral">
                        {tipo}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '12px',
                  color: 'var(--ek-ink-muted)'
                }}>
                  <span>
                    {(r.capacidad_personas ?? 0) > 0
                      ? `Hasta ${r.capacidad_personas} personas`
                      : 'Capacidad por confirmar'}
                  </span>
                  <span style={{ color: 'var(--ek-mustard)', fontWeight: 600 }}>
                    Ver detalle →
                  </span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
