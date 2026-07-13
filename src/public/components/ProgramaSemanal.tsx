export interface HorarioPublico {
  id: string;
  recurso_id?: string;
  nombre: string;
  descripcion: string | null;
  dias_semana: number[];
  hora_inicio: string;
  duracion_minutos: number;
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
        const delDia = horarios.filter((h) => h.dias_semana.includes(dow));
        if (delDia.length === 0) return null;

        const porClase = new Map<
          string,
          { nombre: string; enfoque: string | null; horas: string[] }
        >();
        for (const h of delDia) {
          const clave = `${h.nombre}|${h.descripcion ?? ''}`;
          const entrada = porClase.get(clave) ?? {
            nombre: h.nombre,
            enfoque: h.descripcion,
            horas: []
          };
          entrada.horas.push(h.hora_inicio.slice(0, 5));
          porClase.set(clave, entrada);
        }

        return (
          <div key={dow} className="landing-programa-dia">
            <p className="landing-programa-dia-label">{label}</p>
            {[...porClase.values()].map((c) => (
              <div key={c.nombre} className="landing-programa-clase">
                <p className="landing-programa-nombre">{c.nombre}</p>
                {c.enfoque && <p className="landing-programa-enfoque">{c.enfoque}</p>}
                <div className="landing-programa-horas">
                  {c.horas.sort().map((h) => (
                    <span key={h} className="landing-programa-hora">{h}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
