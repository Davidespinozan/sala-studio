import { agruparPorClase, formatearHora, esManana } from '../lib/programa';

export interface HorarioPublico {
  id: string;
  recurso_id?: string;
  nombre: string;
  descripcion: string | null;
  dias_semana: number[];
  hora_inicio: string;
  duracion_minutos: number;
  /** Cupo de ESTA clase. El cupo NO es de la sala: puede variar por día (15
   *  entre semana, 20 el sábado), así que anunciarlo en la ficha de la sala era
   *  directamente falso para la mitad de la semana. */
  cupo_max?: number | null;
  foto_url: string | null;
}

/** dow según la DB: 0=domingo … 6=sábado. La semana se lee de lunes a domingo. */
const DIAS_SEMANA: { dow: number; label: string }[] = [
  { dow: 1, label: 'Lunes' },
  { dow: 2, label: 'Martes' },
  { dow: 3, label: 'Miércoles' },
  { dow: 4, label: 'Jueves' },
  { dow: 5, label: 'Viernes' },
  { dow: 6, label: 'Sábado' },
  { dow: 0, label: 'Domingo' }
];

/**
 * Programa de la semana de UNA sala: qué se entrena cada día y a qué horas.
 *
 * Vive dentro de la ficha de la sala porque el programa ES de la sala. Y agrupa
 * por clase: la misma clase se repite en muchas franjas (5am…8pm), listarlas una
 * por una repetía el nombre y el enfoque diez veces por día.
 */
export function ProgramaSemanal({ horarios }: { horarios: HorarioPublico[] }) {
  if (horarios.length === 0) return null;

  return (
    <div className="landing-programa">
      {DIAS_SEMANA.map(({ dow, label }) => {
        const clases = agruparPorClase(horarios, dow);
        if (clases.length === 0) return null;

        return (
          <div key={dow} className="landing-programa-dia">
            <p className="landing-programa-dia-label">{label}</p>
            {clases.map((c) => (
              <div key={c.nombre} className="landing-programa-clase">
                <p className="landing-programa-nombre">{c.nombre}</p>
                {c.enfoque && <p className="landing-programa-enfoque">{c.enfoque}</p>}
                {c.cupo != null && (
                  <p className="landing-programa-cupo">{c.cupo} lugares</p>
                )}
                {/* Separadas en MAÑANA y TARDE en vez de colgarle AM/PM a cada
                    chip: con 10 franjas, repetir el sufijo diez veces es ruido —
                    el bloque ya dice de qué parte del día se trata. */}
                {(['am', 'pm'] as const).map((franja) => {
                  const horas = c.horas.filter((h) => (franja === 'am' ? esManana(h) : !esManana(h)));
                  if (horas.length === 0) return null;
                  return (
                    <div key={franja} className="landing-programa-franja">
                      <span className="landing-programa-franja-label">
                        {franja === 'am' ? 'Mañana' : 'Tarde'}
                      </span>
                      <div className="landing-programa-horas">
                        {horas.map((h) => (
                          <span key={h} className="landing-programa-hora">{formatearHora(h)}</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
