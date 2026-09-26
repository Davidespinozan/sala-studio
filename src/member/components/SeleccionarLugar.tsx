import { type SalaLayout } from '@shared/lib/salaLayout';

/**
 * Selector de lugar (Mapa de Salón) del socio. Pinta el layout de la sala con
 * los lugares libres (tappables), los elegidos (resaltados) y los ocupados
 * (deshabilitados). Soporta selección MÚLTIPLE con roles: `seleccion` es un arreglo
 * ordenado donde el índice 0 = TU lugar y 1..N = lugar de cada invitado. Sin
 * invitados, `seleccion` tiene a lo más un elemento (comportamiento de siempre).
 */
export function SeleccionarLugar({
  layout,
  tomados,
  seleccion,
  onToggle
}: {
  layout: SalaLayout;
  tomados: Set<string>;
  seleccion: string[];
  onToggle: (id: string) => void;
}) {
  const lugarEn = (x: number, y: number) => layout.lugares.find((l) => l.x === x && l.y === y);
  const conInvitados = seleccion.length > 1;

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
            const idx = seleccion.indexOf(lugar.id);
            const elegido = idx >= 0;
            const esInvitado = idx > 0;
            const colorSel = esInvitado ? 'var(--sala-accent)' : 'var(--sala-primary)';
            const colorSelText = esInvitado ? 'var(--sala-accent-text, var(--sala-primary-text))' : 'var(--sala-primary-text)';
            return (
              <button
                key={`${x}-${y}`}
                type="button"
                disabled={ocupado}
                onClick={() => onToggle(lugar.id)}
                aria-label={ocupado ? `Lugar ${lugar.label} ocupado` : `Elegir lugar ${lugar.label}`}
                aria-pressed={elegido}
                style={{
                  aspectRatio: '1', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', borderRadius: '10px', fontFamily: 'inherit',
                  fontSize: layout.cols > 8 ? '12px' : '15px', fontWeight: 700, lineHeight: 1,
                  cursor: ocupado ? 'not-allowed' : 'pointer',
                  transition: 'transform .12s ease, box-shadow .12s ease',
                  // HUECO = libre · GRIS tachado = ocupado · PRIMARIO = tu lugar ·
                  // ACENTO = lugar de invitado.
                  border: elegido
                    ? `2px solid ${colorSel}`
                    : ocupado
                      ? '1px solid transparent'
                      : '1.5px solid color-mix(in srgb, var(--sala-primary) 50%, transparent)',
                  background: elegido
                    ? colorSel
                    : ocupado
                      ? 'color-mix(in srgb, var(--sala-text-tertiary) 24%, var(--sala-bg))'
                      : 'var(--sala-surface)',
                  color: elegido
                    ? colorSelText
                    : ocupado
                      ? 'var(--sala-text-tertiary)'
                      : 'var(--sala-primary)',
                  boxShadow: elegido
                    ? `0 4px 14px color-mix(in srgb, ${colorSel} 38%, transparent)`
                    : 'none',
                  transform: elegido ? 'scale(1.05)' : 'none',
                  textDecoration: ocupado ? 'line-through' : 'none'
                }}
              >
                {esInvitado ? `+${idx}` : lugar.label}
              </button>
            );
          })
        )}
      </div>

      <div style={{ display: 'flex', gap: '14px', justifyContent: 'center', marginTop: '10px', fontSize: '11px', color: 'var(--sala-text-tertiary)' }}>
        <Leyenda color="var(--sala-surface)" borde="color-mix(in srgb, var(--sala-primary) 50%, transparent)" label="Libre" />
        <Leyenda color="var(--sala-primary)" borde="var(--sala-primary)" label="Tu lugar" />
        {conInvitados && (
          <Leyenda color="var(--sala-accent)" borde="var(--sala-accent)" label="Invitado" />
        )}
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
