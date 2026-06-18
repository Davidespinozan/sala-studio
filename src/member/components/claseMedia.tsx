/**
 * Media compartida de las tarjetas de clase del socio (ClaseRow + ClaseCard):
 * avatar del coach y foto de la sala, con fallback elegante cuando el gym no
 * subió fotos (iniciales / inicial de marca). Nada hardcodeado: las URLs salen
 * de instructor.foto_url y recurso.foto_url, editables desde el admin.
 */

/** Iniciales (máx 2) de un nombre. */
function iniciales(nombre?: string): string {
  const partes = (nombre ?? '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '?';
  return partes
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** Avatar circular del coach. Foto si hay; si no, iniciales sobre tinte de marca. */
export function CoachAvatar({
  url,
  nombre,
  size = 30,
  dim
}: {
  url?: string;
  nombre?: string;
  size?: number;
  dim?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '999px',
        flexShrink: 0,
        overflow: 'hidden',
        background: 'var(--sala-primary-light)',
        border: '1px solid var(--sala-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: dim ? 0.55 : 1
      }}
    >
      {url ? (
        <img
          src={url}
          alt={nombre ?? ''}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.37), fontWeight: 700, color: 'var(--sala-primary)' }}>
          {iniciales(nombre)}
        </span>
      )}
    </div>
  );
}

/** Foto de la sala. Foto si hay; si no, tile de marca con la inicial. `style`
 *  controla tamaño/forma según el uso (banner arriba o thumb a la izquierda). */
export function SalaImg({
  url,
  nombre,
  disciplina,
  dim,
  inicialSize = 26,
  style
}: {
  url?: string;
  nombre?: string;
  disciplina?: string;
  dim?: boolean;
  inicialSize?: number;
  style?: React.CSSProperties;
}) {
  const label = (disciplina || nombre || '').trim();
  const inicial = label ? label[0].toUpperCase() : '';
  return (
    <div
      aria-hidden="true"
      title={nombre}
      style={{
        flexShrink: 0,
        overflow: 'hidden',
        border: '1px solid var(--sala-border)',
        background:
          'linear-gradient(135deg, var(--sala-primary-light), color-mix(in srgb, var(--sala-accent) 16%, var(--sala-surface)))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: dim ? 0.55 : 1,
        ...style
      }}
    >
      {url ? (
        <img
          src={url}
          alt={nombre ?? ''}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span style={{ fontSize: inicialSize, fontWeight: 700, color: 'var(--sala-primary)' }}>{inicial}</span>
      )}
    </div>
  );
}
