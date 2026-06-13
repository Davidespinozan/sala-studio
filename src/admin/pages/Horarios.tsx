import { useMemo, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';
import { useToast } from '@shared/hooks/useToast';
import {
  useHorariosRecurrentes,
  crearHorarioRecurrente,
  actualizarHorarioRecurrente,
  eliminarHorarioRecurrente,
  generarClasesAhora,
  type HorarioRecurrente,
  type HorarioRecurrenteFormData
} from '../hooks/useHorariosRecurrentes';
import { useRecursosAdmin } from '../hooks/useAdminData';
import { useInstructores } from '../hooks/useInstructores';
import { buscarSolape } from '../lib/horarioOverlap';
import Toggle from '../components/Toggle';
import ConfirmDialog from '../components/ConfirmDialog';
import CardMenuDropdown from '../components/CardMenuDropdown';

const DIAS = [
  { n: 1, corto: 'Lun', largo: 'Lunes' },
  { n: 2, corto: 'Mar', largo: 'Martes' },
  { n: 3, corto: 'Mié', largo: 'Miércoles' },
  { n: 4, corto: 'Jue', largo: 'Jueves' },
  { n: 5, corto: 'Vie', largo: 'Viernes' },
  { n: 6, corto: 'Sáb', largo: 'Sábado' },
  { n: 0, corto: 'Dom', largo: 'Domingo' }
];

function formatDias(dias: number[]): string {
  if (dias.length === 7) return 'Todos los días';
  return DIAS.filter((d) => dias.includes(d.n))
    .map((d) => d.corto)
    .join('/');
}

function formatHora(hora: string): string {
  return hora.slice(0, 5);
}

type ModalState = { mode: 'edit'; horario: HorarioRecurrente } | { mode: 'create' } | null;

export default function Horarios() {
  const { horarios, isLoading, refetch } = useHorariosRecurrentes();
  const { recursos } = useRecursosAdmin();
  const { instructores } = useInstructores();
  const toast = useToast();

  const [modal, setModal] = useState<ModalState>(null);
  const [generando, setGenerando] = useState(false);
  const [eliminando, setEliminando] = useState<HorarioRecurrente | null>(null);

  const instructorById = useMemo(
    () => new Map(instructores.map((i) => [i.id, i])),
    [instructores]
  );

  // Agrupar horarios por sala, respetando el orden de `recursos`.
  const grupos = useMemo(() => {
    const porRecurso = new Map<string, HorarioRecurrente[]>();
    for (const h of horarios) {
      const arr = porRecurso.get(h.recurso_id);
      if (arr) arr.push(h);
      else porRecurso.set(h.recurso_id, [h]);
    }
    return recursos
      .filter((r) => porRecurso.has(r.id))
      .map((r) => ({ recurso: r, items: porRecurso.get(r.id)! }));
  }, [horarios, recursos]);

  const activos = horarios.filter((h) => h.activo).length;

  async function handleGenerar() {
    setGenerando(true);
    const { clasesCreadas, error } = await generarClasesAhora();
    setGenerando(false);
    if (error) {
      toast.error('No pudimos generar las clases. Probá de nuevo.');
      return;
    }
    toast.success(
      clasesCreadas && clasesCreadas > 0
        ? `${clasesCreadas} clase${clasesCreadas === 1 ? '' : 's'} nueva${clasesCreadas === 1 ? '' : 's'} generada${clasesCreadas === 1 ? '' : 's'}.`
        : 'Todo al día — no había clases nuevas para generar.'
    );
  }

  async function handleEliminar() {
    if (!eliminando) return;
    const { error } = await eliminarHorarioRecurrente(eliminando.id);
    if (error) {
      toast.error('No pudimos eliminar el horario. Probá de nuevo.');
      return;
    }
    setEliminando(null);
    toast.success('Horario eliminado. Las clases ya programadas se mantienen.');
    await refetch();
  }

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">HORARIOS</p>
          <h1 className="ek-h2">Horarios recurrentes</h1>
          {!isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
              {horarios.length} {horarios.length === 1 ? 'horario' : 'horarios'}
              {horarios.length > 0 && ` · ${activos} ${activos === 1 ? 'activo' : 'activos'}`}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={handleGenerar}
            disabled={generando}
            className="ek-cta ek-cta--secondary"
          >
            {generando ? 'Generando…' : 'Generar clases ahora'}
          </button>
          <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
            + Nuevo horario
          </button>
        </div>
      </div>

      <div
        style={{
          background: 'var(--sala-primary-light)',
          border: '1px solid var(--sala-border)',
          borderRadius: '12px',
          padding: '12px 16px',
          marginBottom: '20px'
        }}
      >
        <p style={{ fontSize: '13px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
          Definí los horarios fijos de cada sala. Las clases concretas se generan
          automáticamente cada noche para los próximos 60 días. Para verlas al instante
          tocá <strong>Generar clases ahora</strong>.
        </p>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : horarios.length === 0 ? (
        <div
          style={{
            padding: '48px 20px',
            textAlign: 'center',
            background: 'var(--sala-surface)',
            border: '1px solid var(--sala-border)',
            borderRadius: '14px'
          }}
        >
          <p
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--sala-text-tertiary)',
              margin: '0 0 8px'
            }}
          >
            Sin horarios
          </p>
          <h3
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '18px',
              fontWeight: 600,
              color: 'var(--sala-text-primary)',
              margin: '0 0 14px'
            }}
          >
            Todavía no definiste horarios recurrentes.
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 20px' }}>
            Creá el primero para que el sistema genere las clases automáticamente.
          </p>
          <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
            + Nuevo horario
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {grupos.map(({ recurso, items }) => (
            <section key={recurso.id}>
              <h2
                style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '15px',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  color: 'var(--sala-text-primary)',
                  margin: '0 0 10px'
                }}
              >
                {recurso.nombre}
                {!recurso.activo && (
                  <span style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', fontWeight: 500 }}>
                    {' '}· sala inactiva
                  </span>
                )}
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {items.map((h) => (
                  <HorarioRow
                    key={h.id}
                    horario={h}
                    instructorNombre={
                      h.instructor_id ? instructorById.get(h.instructor_id)?.nombre ?? null : null
                    }
                    cupoDefault={recurso.cupo_max_default}
                    onEdit={() => setModal({ mode: 'edit', horario: h })}
                    onDelete={() => setEliminando(h)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {modal && (
        <HorarioModal
          horario={modal.mode === 'edit' ? modal.horario : null}
          recursos={recursos}
          instructores={instructores}
          horarios={horarios}
          onClose={() => setModal(null)}
          onSaved={async (esCreacion) => {
            await refetch();
            setModal(null);
            toast.success(
              esCreacion
                ? 'Horario creado. Tocá "Generar clases ahora" o esperá a la generación nocturna.'
                : 'Horario actualizado.'
            );
          }}
        />
      )}

      <ConfirmDialog
        isOpen={eliminando !== null}
        title={eliminando ? `¿Eliminar "${eliminando.nombre}"?` : ''}
        description="Este horario dejará de generar clases nuevas. Las clases ya programadas y sus reservas se mantienen sin cambios."
        confirmLabel="Eliminar"
        variant="warning"
        onConfirm={handleEliminar}
        onCancel={() => setEliminando(null)}
      />
    </div>
  );
}

// ============================================================================
// Fila de horario
// ============================================================================

function HorarioRow({
  horario: h,
  instructorNombre,
  cupoDefault,
  onEdit,
  onDelete
}: {
  horario: HorarioRecurrente;
  instructorNombre: string | null;
  cupoDefault: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = [
    formatDias(h.dias_semana),
    formatHora(h.hora_inicio),
    `${h.duracion_minutos}min`,
    instructorNombre ?? 'Sin instructor',
    `cupo ${h.cupo_max ?? cupoDefault}`
  ].join('  ·  ');

  return (
    <div
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '14px 16px',
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '12px',
        cursor: 'pointer',
        opacity: h.activo ? 1 : 0.6
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--sala-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--sala-border)';
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p
          style={{
            fontSize: '14px',
            fontWeight: 600,
            color: 'var(--sala-text-primary)',
            margin: '0 0 3px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {h.nombre}
        </p>
        <p
          style={{
            fontSize: '12px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {meta}
        </p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: h.activo ? 'var(--sala-success)' : 'var(--sala-text-tertiary)'
          }}
        >
          {h.activo ? 'Activo' : 'Inactivo'}
        </span>
        <CardMenuDropdown
          items={[
            { label: 'Editar', icon: <Pencil size={15} />, onClick: onEdit },
            { label: 'Eliminar', icon: <Trash2 size={15} />, onClick: onDelete, danger: true, divider: true }
          ]}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Modal crear / editar
// ============================================================================

type RecursoOpt = { id: string; nombre: string; activo: boolean; cupo_max_default: number };
type InstructorOpt = { id: string; nombre: string; activo: boolean };

function HorarioModal({
  horario,
  recursos,
  instructores,
  horarios,
  onClose,
  onSaved
}: {
  horario: HorarioRecurrente | null;
  recursos: RecursoOpt[];
  instructores: InstructorOpt[];
  horarios: HorarioRecurrente[];
  onClose: () => void;
  onSaved: (esCreacion: boolean) => Promise<void>;
}) {
  const tenant = useTenant();
  const { sucursalId } = useSucursal();
  const esCreacion = horario === null;

  const [recursoId, setRecursoId] = useState(horario?.recurso_id ?? '');
  const [dias, setDias] = useState<number[]>(horario?.dias_semana ?? []);
  const [horaInicio, setHoraInicio] = useState(
    horario ? horario.hora_inicio.slice(0, 5) : '07:00'
  );
  // Un horario nuevo arranca con la "Duración default de sesión" del tenant
  // (AjustesReglas → config.reserva.duracion_default_min); uno existente conserva
  // la suya. Fallback 60. (Antes el campo de Ajustes no lo leía nadie.)
  const duracionDefault = (() => {
    const c = (tenant.config as { reserva?: { duracion_default_min?: unknown } } | null)
      ?.reserva?.duracion_default_min;
    return typeof c === 'number' && c > 0 ? c : 60;
  })();
  const [duracion, setDuracion] = useState(String(horario?.duracion_minutos ?? duracionDefault));
  const [nombre, setNombre] = useState(horario?.nombre ?? '');
  const [instructorId, setInstructorId] = useState(horario?.instructor_id ?? '');
  const [cupo, setCupo] = useState(horario?.cupo_max != null ? String(horario.cupo_max) : '');
  const [activo, setActivo] = useState(horario?.activo ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Salas activas + (si se edita) la sala del horario aunque esté inactiva.
  const recursosOpts = recursos.filter((r) => r.activo || r.id === horario?.recurso_id);
  const instructoresOpts = instructores.filter(
    (i) => i.activo || i.id === horario?.instructor_id
  );
  const recursoSel = recursos.find((r) => r.id === recursoId) ?? null;

  function elegirRecurso(id: string) {
    setRecursoId(id);
    // Al crear: prefill del nombre con el de la sala si está vacío.
    if (esCreacion && !nombre.trim()) {
      const r = recursos.find((x) => x.id === id);
      if (r) setNombre(r.nombre);
    }
  }

  function toggleDia(n: number) {
    setDias((prev) =>
      prev.includes(n) ? prev.filter((d) => d !== n) : [...prev, n]
    );
  }

  async function handleSave() {
    setError(null);
    if (!recursoId) {
      setError('Elegí una sala.');
      return;
    }
    if (dias.length === 0) {
      setError('Elegí al menos un día de la semana.');
      return;
    }
    if (!nombre.trim()) {
      setError('El nombre es obligatorio.');
      return;
    }
    const dur = Number(duracion);
    if (!Number.isFinite(dur) || dur <= 0) {
      setError('La duración debe ser mayor a 0.');
      return;
    }
    let cupoVal: number | null = null;
    if (cupo.trim() !== '') {
      const c = Number(cupo);
      if (!Number.isInteger(c) || c <= 0) {
        setError('El cupo debe ser un número entero mayor a 0.');
        return;
      }
      cupoVal = c;
    }
    if (esCreacion && !sucursalId) {
      setError('No hay una sucursal activa. Recargá la página.');
      return;
    }

    // Solape: un horario activo no puede pisar a otro activo de la misma sala
    // (mismo día + rango horario). Los inactivos no generan clases → no se
    // validan. Al editar, buscarSolape se excluye a sí mismo por id.
    if (activo) {
      const solape = buscarSolape(
        {
          id: horario?.id ?? '',
          recurso_id: recursoId,
          dias_semana: dias,
          hora_inicio: horaInicio,
          duracion_minutos: dur,
          activo: true
        },
        horarios
      );
      if (solape) {
        setError(
          `Este horario se solapa con "${solape.nombre}" (${formatDias(solape.dias_semana)} ` +
            `${formatHora(solape.hora_inicio)}) en la misma sala. Ajustá el día o la hora.`
        );
        return;
      }
    }

    const data: HorarioRecurrenteFormData = {
      recurso_id: recursoId,
      dias_semana: [...dias].sort((a, b) => a - b),
      hora_inicio: horaInicio,
      duracion_minutos: dur,
      nombre: nombre.trim(),
      instructor_id: instructorId || null,
      cupo_max: cupoVal,
      activo
    };

    setSaving(true);
    const { error: err } = esCreacion
      ? await crearHorarioRecurrente(tenant.id, sucursalId!, data)
      : await actualizarHorarioRecurrente(horario!.id, data);
    setSaving(false);

    if (err) {
      setError(
        err.includes('HORARIO_SOLAPADO')
          ? 'Este horario se solapa con otro de la misma sala. Ajustá el día o la hora.'
          : 'No pudimos guardar el horario. Probá de nuevo.'
      );
      return;
    }
    await onSaved(esCreacion);
  }

  return (
    <div className="adm-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow ek-eyebrow--mustard">
          {esCreacion ? 'NUEVO HORARIO' : 'EDITAR HORARIO'}
        </p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>
          {nombre || 'Sin nombre'}
        </h3>

        <label className="ek-label">
          Sala
          <select
            value={recursoId}
            onChange={(e) => elegirRecurso(e.target.value)}
            className="ek-input"
          >
            <option value="">Elegí una sala…</option>
            {recursosOpts.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nombre}
                {!r.activo ? ' (inactiva)' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="ek-form-field" style={{ marginTop: '14px' }}>
          <label className="ek-label">Días de la semana</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {DIAS.map((d) => {
              const sel = dias.includes(d.n);
              return (
                <button
                  key={d.n}
                  type="button"
                  onClick={() => toggleDia(d.n)}
                  style={{
                    padding: '7px 12px',
                    minHeight: '36px',
                    borderRadius: '999px',
                    border: `1px solid ${sel ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
                    background: sel ? 'var(--sala-primary)' : 'var(--sala-surface)',
                    color: sel ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit'
                  }}
                >
                  {d.corto}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', marginTop: '14px' }}>
          <label className="ek-label" style={{ flex: 1 }}>
            Hora inicio
            <input
              type="time"
              value={horaInicio}
              onChange={(e) => setHoraInicio(e.target.value)}
              className="ek-input"
            />
          </label>
          <label className="ek-label" style={{ flex: 1 }}>
            Duración (min)
            <input
              type="number"
              min={1}
              value={duracion}
              onChange={(e) => setDuracion(e.target.value)}
              className="ek-input"
            />
          </label>
        </div>

        <label className="ek-label" style={{ marginTop: '14px' }}>
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
          Instructor (opcional)
          <select
            value={instructorId}
            onChange={(e) => setInstructorId(e.target.value)}
            className="ek-input"
          >
            <option value="">Sin instructor</option>
            {instructoresOpts.map((i) => (
              <option key={i.id} value={i.id}>
                {i.nombre}
                {!i.activo ? ' (inactivo)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="ek-label" style={{ marginTop: '14px' }}>
          Cupo máximo
          <input
            type="number"
            min={1}
            value={cupo}
            onChange={(e) => setCupo(e.target.value)}
            className="ek-input"
            placeholder={
              recursoSel
                ? `Default de la sala: ${recursoSel.cupo_max_default}`
                : 'Default de la sala'
            }
          />
          <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
            Dejalo vacío para usar el cupo por defecto de la sala.
          </span>
        </label>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <Toggle
            checked={activo}
            onChange={setActivo}
            label="Horario activo"
            description="Al desactivarlo se detiene la generación de nuevas clases. Las clases ya generadas siguen en la Agenda — cancelalas desde ahí si querés."
          />
        </div>

        {error && <p className="ek-error-text" style={{ marginTop: '10px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button
            onClick={onClose}
            disabled={saving}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button onClick={handleSave} disabled={saving} className="ek-cta" style={{ flex: 1 }}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}
