import { Check } from 'lucide-react';
import { type SalaLayout, ICONO_EMOJI } from '@shared/lib/salaLayout';

export interface OcupanteLugar {
  nombre: string;
  asistio: boolean; // status 'completada' = hizo check-in
}

/**
 * Vista de ocupación del Mapa de Salón (recepción/admin): el layout de la sala
 * con quién está en cada lugar. Lugar ocupado → nombre (✓ si ya hizo check-in);
 * lugar libre → vacío punteado.
 */
export function MapaOcupacion({
  layout,
  ocupacion
}: {
  layout: SalaLayout;
  ocupacion: Map<string, OcupanteLugar>;
}) {
  const lugarEn = (x: number, y: number) => layout.lugares.find((l) => l.x === x && l.y === y);
  const emoji = ICONO_EMOJI[layout.tipo_icono];
  const ocupados = layout.lugares.filter((l) => ocupacion.has(l.id)).length;

  return (
    <div>
      <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '0 0 8px', textAlign: 'center' }}>
        {ocupados} / {layout.lugares.length} lugares ocupados
      </p>
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
            const ocup = ocupacion.get(lugar.id);
            const nombreCorto = ocup ? primerNombre(ocup.nombre) : '';
            return (
              <div
                key={`${x}-${y}`}
                title={ocup ? ocup.nombre : `Lugar ${lugar.label} libre`}
                style={{
                  aspectRatio: '1', display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', borderRadius: '9px', overflow: 'hidden', padding: '2px',
                  fontSize: '9.5px', fontWeight: 700, lineHeight: 1.1, textAlign: 'center',
                  border: ocup ? '1px solid var(--sala-primary)' : '1px dashed var(--sala-border)',
                  background: ocup
                    ? (ocup.asistio ? 'var(--sala-primary)' : 'var(--sala-primary-light)')
                    : 'transparent',
                  color: ocup
                    ? (ocup.asistio ? 'var(--sala-primary-text)' : 'var(--sala-primary)')
                    : 'var(--sala-text-tertiary)'
                }}
              >
                {ocup ? (
                  <>
                    {ocup.asistio && <Check size={11} strokeWidth={3} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', whiteSpace: 'nowrap' }}>
                      {nombreCorto}
                    </span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: '13px', opacity: 0.5 }}>{emoji}</span>
                    <span style={{ opacity: 0.6 }}>{lugar.label}</span>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function primerNombre(nombre: string): string {
  const p = nombre.trim().split(/\s+/);
  return p[0] ?? nombre;
}
