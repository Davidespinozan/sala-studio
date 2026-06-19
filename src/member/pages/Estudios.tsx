import { ArrowRight, Dumbbell, Heart, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useFavoritos } from '@member/hooks/useFavoritos';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

export default function Estudios() {
  const tenant = useTenant();
  const { toggle, isFavorito, count } = useFavoritos();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [soloFavoritas, setSoloFavoritas] = useState(false);

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
        <h1 className="ek-display-xl">Nuestras salas</h1>
        <p className="ek-body-muted" style={{ marginTop: '8px' }}>
          Espacios diseñados para cada disciplina. Elige la que va contigo.
        </p>
      </div>

      {count > 0 && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
          <FiltroChip label="Todas" active={!soloFavoritas} onClick={() => setSoloFavoritas(false)} />
          <FiltroChip
            label={`Favoritas · ${count}`}
            active={soloFavoritas}
            onClick={() => setSoloFavoritas(true)}
          />
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '16px'
      }}>
        {(soloFavoritas ? recursos.filter((r) => isFavorito(r.id)) : recursos).map((r) => {
          // Nada hardcodeado: "restringida" = limita a algún plan (cualquier
          // slug), no por comparar contra 'pro'/'basica'.
          const esRestringido = (r.tiers_permitidos?.length ?? 0) > 0;
          const tiposContenido = r.tipo_contenido ?? [];
          return (
            <Link
              key={r.id}
              to={`/app/estudios/${r.slug}`}
              className="ek-card-interactive"
              style={{
                padding: 0,
                overflow: 'hidden',
                textDecoration: 'none',
                borderRadius: 'var(--ek-r-md)',
                background: 'var(--grad-immersive)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                boxShadow: '0 10px 28px rgba(10, 15, 12, 0.22)'
              }}
            >
              <div style={{
                aspectRatio: '16 / 10',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: r.foto_url ? 'transparent' : 'rgba(255, 255, 255, 0.04)'
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
                  <Dumbbell size={48} strokeWidth={1.25} style={{ color: 'rgba(255, 255, 255, 0.9)', opacity: 0.6 }} />
                )}

                {/* Scrim inferior para profundidad y legibilidad del badge */}
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(to top, rgba(10, 15, 12, 0.55) 0%, transparent 55%)',
                    pointerEvents: 'none'
                  }}
                />

                <span
                  style={{
                    position: 'absolute',
                    top: '12px',
                    left: '12px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '5px 11px',
                    borderRadius: '999px',
                    background: 'rgba(10, 15, 12, 0.55)',
                    backdropFilter: 'blur(6px)',
                    WebkitBackdropFilter: 'blur(6px)',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    color: 'rgba(255, 255, 255, 0.9)',
                    fontSize: '10px',
                    fontWeight: 800,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase'
                  }}
                >
                  {esRestringido ? <><Star size={11} strokeWidth={2.5} fill="currentColor" /> EXCLUSIVO</> : 'ABIERTA'}
                </span>

                <button
                  type="button"
                  aria-label={isFavorito(r.id) ? 'Quitar de favoritas' : 'Agregar a favoritas'}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void toggle(r.id);
                  }}
                  style={{
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    width: '34px',
                    height: '34px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '999px',
                    background: 'rgba(10, 15, 12, 0.55)',
                    backdropFilter: 'blur(6px)',
                    WebkitBackdropFilter: 'blur(6px)',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    cursor: 'pointer'
                  }}
                >
                  <Heart
                    size={17}
                    strokeWidth={2.25}
                    fill={isFavorito(r.id) ? 'var(--sala-accent)' : 'none'}
                    style={{ color: isFavorito(r.id) ? 'var(--sala-accent)' : 'rgba(255, 255, 255, 0.9)' }}
                  />
                </button>
              </div>

              <div style={{ padding: '18px' }}>
                <h3 style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '20px',
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  margin: 0,
                  marginBottom: '6px',
                  color: 'rgba(255, 255, 255, 0.96)'
                }}>{r.nombre}</h3>

                {r.descripcion && (
                  <p style={{
                    fontSize: '13px',
                    color: 'rgba(255, 255, 255, 0.6)',
                    margin: 0,
                    marginBottom: '14px',
                    lineHeight: 1.4
                  }}>{r.descripcion}</p>
                )}

                {tiposContenido.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' }}>
                    {tiposContenido.slice(0, 3).map((tipo) => (
                      <span
                        key={tipo}
                        style={{
                          padding: '4px 10px',
                          borderRadius: '999px',
                          background: 'rgba(255, 255, 255, 0.08)',
                          border: '1px solid rgba(255, 255, 255, 0.12)',
                          color: 'rgba(255, 255, 255, 0.82)',
                          fontSize: '11px',
                          fontWeight: 600
                        }}
                      >
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
                  color: 'rgba(255, 255, 255, 0.5)'
                }}>
                  <span>
                    {(r.capacidad_personas ?? 0) > 0
                      ? `Hasta ${r.capacidad_personas} personas`
                      : 'Capacidad por confirmar'}
                  </span>
                  <span style={{ color: 'rgba(255, 255, 255, 0.9)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    Ver detalle
                    <ArrowRight size={14} strokeWidth={2.25} />
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

function FiltroChip({
  label,
  active,
  onClick
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ek-lift"
      style={{
        padding: '8px 16px',
        minHeight: '36px',
        borderRadius: '999px',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
        background: active ? 'var(--sala-primary)' : 'var(--sala-surface)',
        color: active ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
        border: `1px solid ${active ? 'var(--sala-primary)' : 'var(--sala-border)'}`
      }}
    >
      {label}
    </button>
  );
}
