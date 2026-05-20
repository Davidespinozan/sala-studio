import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { formatDateISO } from '@member/logic/reservaLogic';
import { useInstructores } from '@admin/hooks/useInstructores';

interface RecursoOption {
  id: string;
  nombre: string;
  tipo_contenido: string[] | null;
  cupo_max_default: number;
}

interface Props {
  recursos: RecursoOption[];
  /** Si se abre desde un slot vacío de la grilla, precarga fecha + hora. */
  prefill?: { fecha: Date; hora: number } | null;
  onClose: () => void;
  onCreated: () => void;
}

const NOMBRE_MAX = 100;
const DESC_MAX = 500;

/** Hora 'HH:MM' (o 'HH:MM:SS') → minutos desde medianoche. */
function horaAMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Próxima hora redonda que sea al menos 1h desde ahora. */
function proximaHoraRedonda(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1);
  if (d.getMinutes() > 0) d.setHours(d.getHours() + 1);
  d.setMinutes(0, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}

function nombreSugerido(r: RecursoOption): string {
  const disc = r.tipo_contenido?.[0];
  return disc ? `Clase de ${disc} en ${r.nombre}` : `Clase puntual en ${r.nombre}`;
}

/** S4.3 — crea una clase puntual (origen='manual', sin serie). */
export function CrearClaseManualModal({ recursos, prefill, onClose, onCreated }: Props) {
  const tenant = useTenant();
  const toast = useToast();
  const { instructores } = useInstructores();
  const instructoresActivos = instructores.filter((i) => i.activo);

  const [recursoId, setRecursoId] = useState(recursos[0]?.id ?? '');
  const [instructorId, setInstructorId] = useState('');
  const [fecha, setFecha] = useState(
    prefill ? formatDateISO(prefill.fecha) : formatDateISO(new Date())
  );
  const [horaInicio, setHoraInicio] = useState(
    prefill ? `${String(prefill.hora).padStart(2, '0')}:00` : proximaHoraRedonda()
  );
  const [duracion, setDuracion] = useState(60);
  const [nombre, setNombre] = useState('');
  const [nombreTouched, setNombreTouched] = useState(false);
  const [descripcion, setDescripcion] = useState('');
  const [cupoMax, setCupoMax] = useState(12);
  const [cupoTouched, setCupoTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recursoSel = recursos.find((r) => r.id === recursoId) ?? null;
  const disciplina = recursoSel?.tipo_contenido?.[0] ?? '';
  const hoyISO = formatDateISO(new Date());

  // Autocompletar nombre + cupo al elegir sala (salvo que el admin los haya tocado).
  useEffect(() => {
    if (!recursoSel) return;
    if (!nombreTouched) setNombre(nombreSugerido(recursoSel));
    if (!cupoTouched) setCupoMax(recursoSel.cupo_max_default);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recursoId]);

  async function handleSave() {
    setError(null);

    if (!recursoId) {
      setError('Elegí una sala.');
      return;
    }
    if (!nombre.trim()) {
      setError('El nombre de la clase es obligatorio.');
      return;
    }
    if (nombre.length > NOMBRE_MAX) {
      setError(`El nombre no puede superar ${NOMBRE_MAX} caracteres.`);
      return;
    }
    if (descripcion.length > DESC_MAX) {
      setError(`La descripción no puede superar ${DESC_MAX} caracteres.`);
      return;
    }
    if (!Number.isInteger(cupoMax) || cupoMax < 1 || cupoMax > 100) {
      setError('El cupo máximo debe ser un entero entre 1 y 100.');
      return;
    }
    if (!Number.isInteger(duracion) || duracion < 15 || duracion > 240) {
      setError('La duración debe ser un entero entre 15 y 240 minutos.');
      return;
    }
    if (fecha < hoyISO) {
      setError('La fecha no puede ser pasada.');
      return;
    }
    if (fecha === hoyISO) {
      const ahora = new Date();
      const minNow = ahora.getHours() * 60 + ahora.getMinutes();
      if (horaAMinutos(horaInicio) < minNow + 60) {
        setError('Si la clase es hoy, debe arrancar al menos 1 hora desde ahora.');
        return;
      }
    }

    setSaving(true);

    // Overlap: alguna clase programada de esta sala/fecha que pise el horario.
    const { data: existentes, error: qErr } = await supabase
      .from('clases')
      .select('nombre, hora_inicio, duracion_minutos')
      .eq('recurso_id', recursoId)
      .eq('fecha', fecha)
      .eq('status', 'programada');

    if (qErr) {
      setSaving(false);
      setError('No pudimos verificar disponibilidad. Probá de nuevo.');
      return;
    }

    const nuevoIni = horaAMinutos(horaInicio);
    const nuevoFin = nuevoIni + duracion;
    for (const c of existentes ?? []) {
      const exIni = horaAMinutos(c.hora_inicio as string);
      const exFin = exIni + (c.duracion_minutos as number);
      if (nuevoIni < exFin && exIni < nuevoFin) {
        setSaving(false);
        setError(
          `Ya hay una clase en esta sala a esa hora: "${c.nombre}" de ${(c.hora_inicio as string).slice(0, 5)}.`
        );
        return;
      }
    }

    const { error: insErr } = await supabase.from('clases').insert({
      tenant_id: tenant.id,
      recurso_id: recursoId,
      fecha,
      hora_inicio: `${horaInicio}:00`,
      duracion_minutos: duracion,
      nombre: nombre.trim(),
      disciplina: disciplina || null,
      descripcion: descripcion.trim() || null,
      cupo_max: cupoMax,
      instructor_id: instructorId || null,
      origen: 'manual',
      status: 'programada'
    });

    setSaving(false);
    if (insErr) {
      setError(
        insErr.code === '23505'
          ? 'Ya hay una clase a esa hora. Recargá la agenda.'
          : 'No pudimos crear la clase. Probá de nuevo.'
      );
      return;
    }

    toast.success('Clase creada. Aparecerá en la agenda.');
    onCreated();
    onClose();
  }

  return (
    <div className="ek-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
        <div className="ek-modal-handle" />
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--sala-primary)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Nueva clase
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--sala-text-primary)',
            margin: 0,
            marginBottom: '18px'
          }}
        >
          Clase puntual
        </h3>

        {recursos.length === 0 ? (
          <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: '0 0 18px' }}>
            No hay salas activas. Creá una sala en <strong>Salas</strong> antes de programar clases.
          </p>
        ) : (
          <>
            <label className="ek-label">
              Sala
              <select
                value={recursoId}
                onChange={(e) => setRecursoId(e.target.value)}
                className="ek-input"
              >
                {recursos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nombre}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ display: 'flex', gap: '12px', marginTop: '14px' }}>
              <label className="ek-label" style={{ flex: 1 }}>
                Fecha
                <input
                  type="date"
                  value={fecha}
                  min={hoyISO}
                  onChange={(e) => setFecha(e.target.value)}
                  className="ek-input"
                />
              </label>
              <label className="ek-label" style={{ flex: 1 }}>
                Hora inicio
                <input
                  type="time"
                  value={horaInicio}
                  step={900}
                  onChange={(e) => setHoraInicio(e.target.value)}
                  className="ek-input"
                />
              </label>
            </div>

            <label className="ek-label" style={{ marginTop: '14px' }}>
              Nombre de la clase
              <input
                type="text"
                value={nombre}
                maxLength={NOMBRE_MAX}
                onChange={(e) => {
                  setNombre(e.target.value);
                  setNombreTouched(true);
                }}
                className="ek-input"
                placeholder="Ej: Clase de Yoga en Sala Yoga"
              />
            </label>

            <label className="ek-label" style={{ marginTop: '14px' }}>
              Descripción
              <textarea
                value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)}
                className="ek-input"
                rows={2}
                maxLength={DESC_MAX}
                placeholder="Opcional."
              />
              <span style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)' }}>
                {descripcion.length}/{DESC_MAX}
              </span>
            </label>

            <div style={{ display: 'flex', gap: '12px', marginTop: '14px' }}>
              <label className="ek-label" style={{ flex: 1 }}>
                Cupo máximo
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={cupoMax || ''}
                  onChange={(e) => {
                    setCupoMax(parseInt(e.target.value, 10) || 0);
                    setCupoTouched(true);
                  }}
                  className="ek-input"
                />
              </label>
              <label className="ek-label" style={{ flex: 1 }}>
                Duración (min)
                <input
                  type="number"
                  min={15}
                  max={240}
                  step={5}
                  value={duracion || ''}
                  onChange={(e) => setDuracion(parseInt(e.target.value, 10) || 0)}
                  className="ek-input"
                />
              </label>
            </div>

            <label className="ek-label" style={{ marginTop: '14px' }}>
              Instructor
              <select
                value={instructorId}
                onChange={(e) => setInstructorId(e.target.value)}
                className="ek-input"
              >
                <option value="">Sin instructor asignado</option>
                {instructoresActivos.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.nombre}
                  </option>
                ))}
              </select>
            </label>

            {error && <p className="ek-error-text" style={{ marginTop: '10px' }}>{error}</p>}

            <div style={{ display: 'flex', gap: '10px', marginTop: '18px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1 }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="ek-cta"
                style={{ flex: 1 }}
              >
                {saving ? 'Creando…' : 'Crear clase'}
              </button>
            </div>
          </>
        )}

        {recursos.length === 0 && (
          <button type="button" onClick={onClose} className="ek-cta ek-cta--full">
            Entendido
          </button>
        )}
      </div>
    </div>
  );
}
