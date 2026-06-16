import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, ArrowRight } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { MARKETING_DOMAIN } from '@shared/providers/TenantProvider';

/**
 * Buscador de estudios/gimnasios para la landing de SALA. El visitante escribe
 * el nombre de su gym y lo llevamos a SU subdominio para iniciar sesión ahí
 * (la sesión es por origen → cada tenant entra en su propio sitio). Anon puede
 * leer tenants activos (RLS tenants_read_public_by_slug).
 */
interface TenantResultado {
  slug: string;
  nombre: string;
  logo: string | null;
}

function extraerLogo(branding: unknown): string | null {
  if (!branding || typeof branding !== 'object') return null;
  const b = branding as Record<string, unknown>;
  const url = b.isotipo_url ?? b.logo_url;
  return typeof url === 'string' && url ? url : null;
}

function irAlEstudio(slug: string) {
  window.location.href = `https://${slug}.${MARKETING_DOMAIN}/login`;
}

export default function BuscarEstudio({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [resultados, setResultados] = useState<TenantResultado[]>([]);
  const [buscando, setBuscando] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResultados([]);
      setBuscando(false);
      return;
    }
    setBuscando(true);
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('tenants')
        .select('slug, nombre, branding')
        .ilike('nombre', `%${term}%`)
        .eq('status', 'activo')
        .order('nombre', { ascending: true })
        .limit(8);
      setResultados(
        (data ?? []).map((t) => ({ slug: t.slug, nombre: t.nombre, logo: extraerLogo(t.branding) }))
      );
      setBuscando(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const term = q.trim();
  const sinResultados = term.length >= 2 && !buscando && resultados.length === 0;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Buscá tu estudio"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(10, 15, 12, 0.55)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 'max(64px, 12vh) 16px 16px'
      }}
    >
      <div
        className="sala-brand"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '480px',
          background: 'var(--sala-surface)',
          borderRadius: '16px',
          boxShadow: '0 24px 60px rgba(10, 15, 12, 0.32)',
          overflow: 'hidden'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 0' }}>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '18px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              margin: 0,
              color: 'var(--sala-text-primary)'
            }}
          >
            Buscá tu estudio
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              display: 'inline-flex',
              padding: '6px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--sala-text-tertiary)'
            }}
          >
            <X size={18} strokeWidth={2.25} />
          </button>
        </div>

        <div style={{ padding: '12px 20px 0' }}>
          <div style={{ position: 'relative' }}>
            <Search
              size={16}
              strokeWidth={2.25}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: '12px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--sala-text-tertiary)'
              }}
            />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Nombre de tu gym o estudio"
              className="ek-input"
              style={{ paddingLeft: '36px' }}
            />
          </div>
          <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '8px 0 0' }}>
            Escribí el nombre de tu gimnasio para entrar a tu cuenta.
          </p>
        </div>

        <div style={{ padding: '14px 12px 16px', maxHeight: '46vh', overflowY: 'auto' }}>
          {buscando && (
            <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', padding: '8px 8px' }}>Buscando…</p>
          )}
          {sinResultados && (
            <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', padding: '8px 8px' }}>
              No encontramos ningún estudio con ese nombre. Probá con otra palabra.
            </p>
          )}
          {resultados.map((t) => (
            <button
              key={t.slug}
              type="button"
              onClick={() => irAlEstudio(t.slug)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 12px',
                border: 'none',
                background: 'transparent',
                borderRadius: '10px',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--sala-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '9px',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  background: 'var(--sala-primary-light)',
                  color: 'var(--sala-primary)',
                  fontWeight: 700,
                  fontSize: '15px'
                }}
              >
                {t.logo ? (
                  <img src={t.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  t.nombre.charAt(0).toUpperCase()
                )}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: '15px', fontWeight: 600, color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.nombre}
              </span>
              <ArrowRight size={16} strokeWidth={2.25} style={{ color: 'var(--sala-text-tertiary)', flexShrink: 0 }} />
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
