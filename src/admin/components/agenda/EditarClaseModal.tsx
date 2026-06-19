import { useState } from 'react';
import { useToast } from '@shared/hooks/useToast';
import type { Clase } from '@member/logic/claseAdapter';
import { useEditarCancelarClase, type ClasePatch } from '@admin/hooks/useEditarCancelarClase';
import { useInstructores } from '@admin/hooks/useInstructores';

interface Props {
  clase: Clase;
  /** Inscritos activos (confirmada+completada) — para validar que el cupo no baje de eso. */
  inscritosActivos: number;
  onClose: () => void;
  onSaved: (patch: ClasePatch) => Promise<void>;
}

const DESC_MAX = 500;

/** S4.3 — edita una clase puntual (nombre, descripción, cupo, duración). */
export function EditarClaseModal({ clase, inscritosActivos, onClose, onSaved }: Props) {
  const toast = useToast();
  const { updateClase, updating } = useEditarCancelarClase(clase);
  const { instructores } = useInstructores();

  const [nombre, setNombre] = useState(clase.nombre);
  const [descripcion, setDescripcion] = useState(clase.descripcion ?? '');
  const [cupoMax, setCupoMax] = useState<number>(clase.cupoMax);
  const [duracion, setDuracion] = useState<number>(clase.duracionMinutos);
  const [instructorId, setInstructorId] = useState<string>(clase.instructorId ?? '');
  const [error, setError] = useState<string | null>(null);

  // Opciones del dropdown: instructores activos + el ya asignado aunque esté
  // inactivo (para que el prefill no se pierda).
  const opcionesInstructor = instructores.filter(
    (i) => i.activo || i.id === clase.instructorId
  );

  async function handleSave() {
    setError(null);

    if (!nombre.trim()) {
      setError('El nombre de la clase es obligatorio.');
      return;
    }
    if (descripcion.length > DESC_MAX) {
      setError(`La descripción no puede superar ${DESC_MAX} caracteres.`);
      return;
    }
    if (!Number.isInteger(cupoMax) || cupoMax < 1) {
      setError('El cupo máximo debe ser un número entero de al menos 1.');
      return;
    }
    if (cupoMax < inscritosActivos) {
      setError(
        `No puedes bajar el cupo a ${cupoMax}: hay ${inscritosActivos} inscritos. Cancela inscritos primero.`
      );
      return;
    }
    if (!Number.isInteger(duracion) || duracion < 15 || duracion > 240) {
      setError('La duración debe ser un número entero entre 15 y 240 minutos.');
      return;
    }

    const patch: ClasePatch = {
      nombre: nombre.trim(),
      descripcion: descripcion.trim() || null,
      cupo_max: cupoMax,
      duracion_minutos: duracion,
      instructor_id: instructorId || null
    };
    const { error: err } = await updateClase(patch);
    if (err) {
      setError('No pudimos guardar los cambios. Prueba de nuevo.');
      return;
    }
    toast.success('Clase actualizada');
    await onSaved(patch);
    onClose();
  }

  return (
    <div className="ek-modal-backdrop" onClick={() => !updating && onClose()}>
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
          Editar clase
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
          {clase.salaNombre ?? clase.nombre}
        </h3>

        <label className="ek-label">
          Nombre de la clase
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="ek-input"
            placeholder="Ej: Yoga Flow matutino"
          />
        </label>

        <label className="ek-label" style={{ marginTop: '14px' }}>
          Descripción
          <textarea
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            className="ek-input"
            rows={3}
            maxLength={DESC_MAX}
            placeholder="Opcional. Qué trae esta clase, nivel, etc."
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
              step={1}
              value={cupoMax || ''}
              onChange={(e) => setCupoMax(parseInt(e.target.value, 10) || 0)}
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

        <p style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', margin: '8px 0 0' }}>
          Inscritos actuales: {inscritosActivos}. El cupo no puede ser menor a ese número.
        </p>

        <label className="ek-label" style={{ marginTop: '14px' }}>
          Instructor
          <select
            value={instructorId}
            onChange={(e) => setInstructorId(e.target.value)}
            className="ek-input"
          >
            <option value="">Sin instructor asignado</option>
            {opcionesInstructor.map((i) => (
              <option key={i.id} value={i.id}>
                {i.nombre}
                {!i.activo ? ' (inactivo)' : ''}
              </option>
            ))}
          </select>
        </label>

        {error && <p className="ek-error-text" style={{ marginTop: '10px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '10px', marginTop: '18px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={updating}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={updating}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {updating ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}
