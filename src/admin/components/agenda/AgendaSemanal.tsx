import { Fragment } from 'react';
import { formatDateISO } from '@member/logic/reservaLogic';
import { diasEntre } from '@shared/lib/timezone';
import type { Clase } from '@member/logic/claseAdapter';
import { ClaseCellAdmin } from './ClaseCellAdmin';

const HORAS = Array.from({ length: 17 }, (_, i) => 6 + i); // 06:00..22:00

interface Props {
  clases: Clase[];
  inicioSemana: Date;
  /** 'YYYY-MM-DD' de hoy en la timezone del gym (S4.4). */
  hoyISO: string;
  onClickClase: (clase: Clase) => void;
  onClickSlotVacio?: (date: Date, hora: number) => void;
}

/** Grid 7 días × 17 horas. Cada celda muestra las clases que arrancan en esa hora.
 *  Día actual: columna highlighted con tinte salvia. Celda vacía: botón "+" hover. */
export function AgendaSemanal({ clases, inicioSemana, hoyISO, onClickClase, onClickSlotVacio }: Props) {
  // S4.4: indexar por la fecha/hora del gym (clase.fechaISO + horaLabel),
  // no por componentes browser-local de un instante UTC.
  const inicioISO = formatDateISO(inicioSemana);
  const slotMap = new Map<string, Clase[]>();
  for (const c of clases) {
    const dayIdx = diasEntre(inicioISO, c.fechaISO);
    if (dayIdx < 0 || dayIdx > 6) continue;
    const hora = parseInt(c.horaLabel.slice(0, 2), 10);
    const key = `${dayIdx}_${hora}`;
    const arr = slotMap.get(key) ?? [];
    arr.push(c);
    slotMap.set(key, arr);
  }

  const dias = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(inicioSemana);
    d.setDate(inicioSemana.getDate() + i);
    return d;
  });

  // Wrapper con overflow horizontal + sombra lateral indicadora cuando hay scroll.
  // En viewports estrechos (900-1100px) el grid no se aplasta: cada día mantiene
  // ~130px mínimo y el contenedor scrollea horizontalmente.
  return (
    <div className="adm-agenda-scroll" style={{ position: 'relative' }}>
      <div
        style={{
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
          paddingRight: '12px'
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '56px repeat(7, minmax(130px, 1fr))',
            gap: '4px',
            background: 'var(--sala-bg)',
            padding: '8px 0',
            minWidth: '966px'
          }}
        >
      {/* Header: corner vacío + 7 day headers */}
      <div />
      {dias.map((d) => {
        const esHoy = formatDateISO(d) === hoyISO;
        return (
          <div
            key={d.toISOString()}
            style={{
              padding: '10px 4px',
              textAlign: 'center',
              background: esHoy ? 'var(--sala-primary-light)' : 'var(--sala-surface)',
              border: `1px solid ${esHoy ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
              borderRadius: '10px',
              position: 'sticky',
              top: 0,
              zIndex: 2
            }}
          >
            <p
              style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.1em',
                color: esHoy ? 'var(--sala-primary)' : 'var(--sala-text-secondary)',
                margin: 0,
                marginBottom: '2px'
              }}
            >
              {d
                .toLocaleDateString('es-MX', { weekday: 'short' })
                .replace('.', '')
                .slice(0, 3)
                .toUpperCase()}
            </p>
            <p
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '18px',
                fontWeight: 700,
                color: esHoy ? 'var(--sala-primary)' : 'var(--sala-text-primary)',
                margin: 0,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '-0.02em',
                lineHeight: 1
              }}
            >
              {d.getDate()}
            </p>
          </div>
        );
      })}

      {/* Rows */}
      {HORAS.map((hora) => (
        <Fragment key={hora}>
          <div
            style={{
              padding: '6px 4px',
              textAlign: 'right',
              fontSize: '11px',
              color: 'var(--sala-text-tertiary)',
              fontVariantNumeric: 'tabular-nums',
              alignSelf: 'start',
              paddingTop: '8px'
            }}
          >
            {String(hora).padStart(2, '0')}:00
          </div>
          {dias.map((d, dayIdx) => {
            const key = `${dayIdx}_${hora}`;
            const clasesEnSlot = slotMap.get(key) ?? [];
            const esHoy = formatDateISO(d) === hoyISO;
            return (
              <div
                key={key}
                style={{
                  minHeight: '64px',
                  padding: '2px',
                  background: esHoy ? 'rgba(232, 240, 235, 0.35)' : 'transparent',
                  borderRadius: '6px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '3px'
                }}
              >
                {clasesEnSlot.map((clase) => (
                  <ClaseCellAdmin
                    key={clase.id}
                    clase={clase}
                    onClick={() => onClickClase(clase)}
                  />
                ))}
                {clasesEnSlot.length === 0 && onClickSlotVacio && (
                  <button
                    type="button"
                    onClick={() => onClickSlotVacio(d, hora)}
                    aria-label={`Crear clase a las ${hora}:00`}
                    title="Crear clase manual (próximamente)"
                    style={{
                      width: '100%',
                      flex: 1,
                      minHeight: '58px',
                      background: 'transparent',
                      border: '1px dashed transparent',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      color: 'var(--sala-text-tertiary)',
                      fontSize: '20px',
                      fontFamily: 'inherit',
                      opacity: 0,
                      transition: 'opacity 0.15s ease, border-color 0.15s ease, background 0.15s ease'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.opacity = '1';
                      e.currentTarget.style.borderColor = 'var(--sala-border-strong)';
                      e.currentTarget.style.background = 'rgba(232, 240, 235, 0.5)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.opacity = '0';
                      e.currentTarget.style.borderColor = 'transparent';
                      e.currentTarget.style.background = 'transparent';
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.opacity = '1';
                      e.currentTarget.style.borderColor = 'var(--sala-primary)';
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.opacity = '0';
                      e.currentTarget.style.borderColor = 'transparent';
                    }}
                  >
                    +
                  </button>
                )}
              </div>
            );
          })}
          </Fragment>
        ))}
        </div>
      </div>
      {/* Sombra lateral indicadora de scroll horizontal (visible en 900-1100px) */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: '24px',
          pointerEvents: 'none',
          background:
            'linear-gradient(to left, rgba(26, 31, 28, 0.08), rgba(26, 31, 28, 0))'
        }}
      />
    </div>
  );
}
