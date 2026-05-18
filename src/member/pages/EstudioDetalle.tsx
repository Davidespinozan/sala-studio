import { useParams, Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import type { Database } from '@shared/types/database';

type RecursoDetalle = Database['public']['Tables']['recursos']['Row'];

export default function EstudioDetalle() {
  const { slug } = useParams<{ slug: string }>();
  const tenant = useTenant();
  const { usuario } = useAuth();
  const navigate = useNavigate();
  const [recurso, setRecurso] = useState<RecursoDetalle | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!slug) return;
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('recursos')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('slug', slug!)
        .eq('activo', true)
        .maybeSingle();

      if (!mounted) return;
      if (error) console.error('[EstudioDetalle]', error);
      else setRecurso(data);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [slug, tenant.id]);

  if (isLoading) {
    return (
      <div className="ek-container">
        <div className="ek-skeleton" style={{ height: '500px', borderRadius: 'var(--ek-r-card)' }} />
      </div>
    );
  }

  if (!recurso) {
    return (
      <div className="ek-container">
        <div className="ek-empty">
          <p className="ek-empty-title">Estudio no encontrado</p>
          <Link to="/app/estudios" className="ek-cta" style={{ marginTop: '16px' }}>
            Ver todos los estudios
          </Link>
        </div>
      </div>
    );
  }

  const esPro = recurso.tiers_permitidos.length === 1 && recurso.tiers_permitidos[0] === 'pro';
  const usuarioPuedeUsar = usuario?.membresia_tier
    ? recurso.tiers_permitidos.includes(usuario.membresia_tier)
    : false;
  const tipoContenido = recurso.tipo_contenido ?? [];
  const equipo = recurso.equipo_incluido ?? [];

  return (
    <div className="ek-container">
      <button
        onClick={() => navigate(-1)}
        className="ek-icon-btn"
        style={{ marginBottom: '16px', width: 'auto', padding: '8px 14px', fontSize: '13px' }}
      >
        ← Volver
      </button>

      {/* Foto grande */}
      <div style={{
        background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
        aspectRatio: '16 / 9',
        borderRadius: 'var(--ek-r-card)',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: '24px',
        overflow: 'hidden',
        border: '0.5px solid var(--ek-line)'
      }}>
        {recurso.foto_url ? (
          <img
            src={recurso.foto_url}
            alt={recurso.nombre}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{
            fontSize: '11px',
            color: 'var(--ek-ink-faint)',
            letterSpacing: '0.2em',
            fontWeight: 600
          }}>FOTO PRÓXIMAMENTE</span>
        )}

        <span
          className={esPro ? 'ek-badge ek-badge--outline' : 'ek-badge'}
          style={{ position: 'absolute', top: '16px', left: '16px' }}
        >
          {esPro ? '★ PRO' : 'BÁSICA'}
        </span>
      </div>

      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>ESTUDIO</p>
        <h1 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(32px, 8vw, 48px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.05,
          margin: 0
        }}>{recurso.nombre}</h1>
        {recurso.descripcion && (
          <p className="ek-body" style={{ marginTop: '12px', color: 'var(--ek-ink-muted)' }}>
            {recurso.descripcion}
          </p>
        )}
      </div>

      {tipoContenido.length > 0 && (
        <div style={{ marginBottom: '32px' }}>
          <p className="ek-eyebrow" style={{ marginBottom: '10px' }}>IDEAL PARA</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {tipoContenido.map((tipo) => (
              <span key={tipo} className="ek-badge ek-badge--neutral" style={{ padding: '8px 14px' }}>
                {tipo}
              </span>
            ))}
          </div>
        </div>
      )}

      {(recurso.capacidad_personas ?? 0) > 0 && (
        <div className="ek-stat-card" style={{ marginBottom: '24px' }}>
          <p className="ek-eyebrow" style={{ marginBottom: '6px' }}>CAPACIDAD</p>
          <p className="ek-kpi">
            {recurso.capacidad_personas}{' '}
            <span style={{
              fontSize: '15px',
              fontWeight: 500,
              color: 'var(--ek-ink-muted)',
              letterSpacing: 'normal'
            }}>personas</span>
          </p>
        </div>
      )}

      {equipo.length > 0 && (
        <div className="ek-card" style={{ marginBottom: '24px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '14px' }}>
            EQUIPO INCLUIDO
          </p>
          <ul style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
          }}>
            {equipo.map((item) => (
              <li
                key={item}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  fontSize: '14px',
                  color: 'var(--ek-ink)'
                }}
              >
                <span style={{ color: 'var(--ek-mustard)', marginTop: '2px' }}>✓</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {recurso.estilo_visual && (
        <div className="ek-card" style={{ marginBottom: '24px' }}>
          <p className="ek-eyebrow" style={{ marginBottom: '10px' }}>ESTILO</p>
          <p className="ek-body" style={{ lineHeight: 1.6 }}>
            {recurso.estilo_visual}
          </p>
        </div>
      )}

      <div style={{ marginBottom: '24px' }}>
        {usuarioPuedeUsar ? (
          <Link
            to={`/app/reservar?recurso=${recurso.slug}`}
            className="ek-cta ek-cta--full"
            style={{ minHeight: '52px', fontSize: '15px' }}
          >
            Reservar este estudio →
          </Link>
        ) : (
          <div className="ek-card" style={{
            borderColor: 'var(--ek-mustard-dim)',
            background: 'var(--ek-mustard-soft)',
            textAlign: 'center'
          }}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>
              PLAN PRO REQUERIDO
            </p>
            <p className="ek-body" style={{ marginBottom: '14px' }}>
              Tu plan actual no incluye acceso a este estudio.
            </p>
            <Link to="/app/perfil" className="ek-cta">
              Ver mi plan
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
