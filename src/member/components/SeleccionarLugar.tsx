import { type SalaLayout } from '@shared/lib/salaLayout';

/**
 * Selector de lugar (Mapa de Salón) del socio. Pinta el layout de la sala con
 * los lugares libres (tappables), el elegido (resaltado) y los ocupados
 * (deshabilitados). Misma disposición (cols/filas/x/y) que diseñó el admin.
 */
export function SeleccionarLugar({
  layout,
  tomados,
  seleccionado,
  onSelect
}: {
  layout: SalaLayout;
  tomados: Set<string>;
  seleccionado: string | null;
  onSelect: (id: string) => void;
}) {
  const lugarEn = (x: number, y: number) => layout.lugares.find((l) => l.x === x && l.y === y);

  return (
    <div>
      <div
        style={{
          textAlign: 'center', fontSize: '10px', fontWeight: 800, letterSpacing: '0.16em',
          textTransform: 'uppercase', color: 'var(--sala-text-tertiary)', background: 'var(--sala-bg)',
          borderRadius: '8px', padding: '6px', marginBottom: '8px'
        }}
      >
        ▲ Frente
      </div>

      <div style={{ display: 'grid', gap: '6px', gridTemplateColumns: `repeat(${layout.cols}, 1fr)` }}>
        {Array.from({ length: layout.rows }).flatMap((_, y) =>
          Array.from({ length: layout.cols }).map((__, x) => {
            const lugar = lugarEn(x, y);
            if (!lugar) return <div key={`${x}-${y}`} aria-hidden="true" />;
            const ocupado = tomados.has(lugar.id);
            const elegido = seleccionado === lugar.id;
            return (
              <button
                key={`${x}-${y}`}
                type="button"
                disabled={ocupado}
                onClick={() => onSelect(lugar.id)}
                aria-label={ocupado ? `Lugar ${lugar.label} ocupado` : `Elegir lugar ${lugar.label}`}
                aria-pressed={elegido}
                style={{
                  aspectRatio: '1', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', borderRadius: '10px', fontFamily: 'inherit',
                  fontSize: layout.cols > 8 ? '12px' : '15px', fontWeight: 700, lineHeight: 1,
                  cursor: ocupado ? 'not-allowed' : 'pointer',
                  transition: 'transform .12s ease, box-shadow .12s ease',
                  // Convención clara: HUECO = libre · RELLENO GRIS (tachado) = ocupado
                  // · RELLENO PRIMARIO = tu lugar.
                  border: elegido
                    ? '2px solid var(--sala-primary)'
                    : ocupado
                      ? '1px solid transparent'
                      : '1.5px solid color-mix(in srgb, var(--sala-primary) 50%, transparent)',
                  background: elegido
                    ? 'var(--sala-primary)'
                    : ocupado
                      ? 'color-mix(in srgb, var(--sala-text-tertiary) 24%, var(--sala-bg))'
                      : 'var(--sala-surface)',
                  color: elegido
                    ? 'var(--sala-primary-text)'
                    : ocupado
                      ? 'var(--sala-text-tertiary)'
                      : 'var(--sala-primary)',
                  boxShadow: elegido
                    ? '0 4px 14px color-mix(in srgb, var(--sala-primary) 38%, transparent)'
                    : 'none',
                  transform: elegido ? 'scale(1.05)' : 'none',
                  textDecoration: ocupado ? 'line-through' : 'none'
                }}
              >
                {lugar.label}
              </button>
            );
          })
        )}
      </div>

      <div style={{ display: 'flex', gap: '14px', justifyContent: 'center', marginTop: '10px', fontSize: '11px', color: 'var(--sala-text-tertiary)' }}>
        <Leyenda color="var(--sala-surface)" borde="color-mix(in srgb, var(--sala-primary) 50%, transparent)" label="Libre" />
        <Leyenda color="var(--sala-primary)" borde="var(--sala-primary)" label="Tu lugar" />
        <Leyenda color="color-mix(in srgb, var(--sala-text-tertiary) 24%, var(--sala-bg))" borde="transparent" label="Ocupado" />
      </div>
    </div>
  );
}

function Leyenda({ color, borde, label }: { color: string; borde: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
      <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: color, border: `1px solid ${borde}` }} />
      {label}
    </span>
  );
}
