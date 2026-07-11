import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

/** Shell de lectura para las páginas legales (Privacidad / Términos). */
export function LegalLayout({
  titulo,
  actualizado,
  children
}: {
  titulo: string;
  actualizado: string;
  children: ReactNode;
}) {
  return (
    <div style={{ background: 'var(--sala-bg)', minHeight: '70vh', padding: '32px 20px 80px' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>
        <Link
          to="/signup"
          className="adm-link"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', marginBottom: '20px' }}
        >
          <ArrowLeft size={15} strokeWidth={2.25} />
          Volver
        </Link>
        <h1
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(26px, 5vw, 34px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: '0 0 6px',
            color: 'var(--sala-text-primary)'
          }}
        >
          {titulo}
        </h1>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: '0 0 28px' }}>
          Última actualización: {actualizado}
        </p>
        <div
          style={{
            fontSize: '15px',
            lineHeight: 1.65,
            color: 'var(--sala-text-secondary)'
          }}
          className="legal-body"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Sección con título para las páginas legales. */
export function LegalSection({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: '24px' }}>
      <h2
        style={{
          fontSize: '17px',
          fontWeight: 700,
          color: 'var(--sala-text-primary)',
          margin: '0 0 8px',
          letterSpacing: '-0.01em'
        }}
      >
        {titulo}
      </h2>
      {children}
    </section>
  );
}
