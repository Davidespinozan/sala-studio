import { useMemo, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import ImageUploader from '../components/ImageUploader';
import { useSucursal } from '../providers/SucursalProvider';
import { useToast } from '@shared/hooks/useToast';
import {
  useHorariosRecurrentes,
  crearHorarioRecurrente,
  actualizarHorarioRecurrente,
  aplicarIdentidadAClase,
  eliminarHorarioRecurrente,
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
    // Todas las salas ACTIVAS (aunque no tengan horarios) → puerta de entrada
    // para programarlas. Más salas inactivas que aún conserven horarios (legacy).
    return recursos
      .filter((r) => r.activo || porRecurso.has(r.id))
      .map((r) => ({ recurso: r, items: porRecurso.get(r.id) ?? [] }));
  }, [horarios, recursos]);

  const activos = horarios.filter((h) => h.activo).length;

  async function handleEliminar() {
    if (!eliminando) return;
    const { error } = await eliminarHorarioRecurrente(eliminando.id);
    if (error) {
      toast.error('No pudimos eliminar el horario. Prueba de nuevo.');
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
          Define acá la grilla semanal de cada sala. Las clases aparecen solas en la
          Agenda y en la app del socio — sin generar nada. Cualquier cambio que hagas
          se refleja al instante.
        </p>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : grupos.length === 0 ? (
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
            Crea una sala primero y después define su grilla semanal.
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
                {items.length === 0 ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px',
                      flexWrap: 'wrap',
                      padding: '14px 16px',
                      background: 'var(--sala-surface)',
                      border: '1px dashed var(--sala-border)',
                      borderRadius: '12px'
                    }}
                  >
                    <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0 }}>
                      Esta sala todavía no tiene clases. Agrega su primer horario para que aparezcan en la agenda.
                    </p>
                    <button
                      onClick={() => setModal({ mode: 'create' })}
                      className="ek-cta ek-cta--secondary"
                      style={{ padding: '8px 14px', fontSize: '12px', flexShrink: 0 }}
                    >
                      + Agregar horario
                    </button>
                  </div>
                ) : (
                  items.map((h) => (
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
                  ))
                )}
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
                ? 'Horario creado. Toca "Generar clases ahora" o espera a la generación nocturna.'
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
  const toast = useToast();
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
  // Una misma sala puede tener una clase distinta cada día: el enfoque, la
  // disciplina y la foto son de la CLASE, no de la sala.
  const [descripcion, setDescripcion] = useState(horario?.descripcion ?? '');
  const [disciplina, setDisciplina] = useState(horario?.disciplina ?? '');
  const [fotoUrl, setFotoUrl] = useState<string | null>(horario?.foto_url ?? null);
  // Una clase suele tener varias franjas (5am, 6am, 7am…). El enfoque, la
  // disciplina y la foto son de la CLASE, no de la franja: por default se
  // aplican a todas sus hermanas para que no queden desparejas.
  const [aplicarATodas, setAplicarATodas] = useState(true);
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

  // Otras franjas de ESTA misma clase (mismo nombre, misma sala).
  const hermanas = horario
    ? horarios.filter(
        (h) =>
          h.id !== horario.id &&
          h.recurso_id === horario.recurso_id &&
          h.nombre === horario.nombre
      )
    : [];

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
      setError('Elige una sala.');
      return;
    }
    if (dias.length === 0) {
      setError('Elige al menos un día de la semana.');
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
      setError('No hay una sucursal activa. Recarga la página.');
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
            `${formatHora(solape.hora_inicio)}) en la misma sala. Ajusta el día o la hora.`
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
      descripcion: descripcion.trim() || null,
      disciplina: disciplina.trim() || null,
      foto_url: fotoUrl,
      instructor_id: instructorId || null,
      cupo_max: cupoVal,
      activo
    };

    setSaving(true);
    const { error: err } = esCreacion
      ? await crearHorarioRecurrente(tenant.id, sucursalId!, data)
      : await actualizarHorarioRecurrente(horario!.id, data);

    // La identidad (nombre/enfoque/disciplina/foto) es de la CLASE, no de la
    // franja: si el admin lo pidió, se propaga a las demás franjas con el nombre
    // ANTERIOR (si le cambió el nombre, hay que buscarlas por el viejo).
    if (!err && !esCreacion && aplicarATodas && hermanas.length > 0) {
      const { error: errProp, afectados } = await aplicarIdentidadAClase(
        tenant.id,
        horario!.recurso_id,
        horario!.nombre,
        {
          nombre: data.nombre,
          descripcion: data.descripcion,
          disciplina: data.disciplina,
          foto_url: data.foto_url
        }
      );
      if (errProp) {
        setSaving(false);
        setError('Se guardó esta franja, pero no pudimos aplicarlo a las demás. Probá de nuevo.');
        return;
      }
      toast.success(`Aplicado a las ${afectados} franjas de "${data.nombre}".`);
    }

    setSaving(false);

    if (err) {
      setError(
        err.includes('HORARIO_SOLAPADO')
          ? 'Este horario se solapa con otro de la misma sala. Ajusta el día o la hora.'
          : 'No pudimos guardar el horario. Prueba de nuevo.'
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
            <option value="">Elige una sala…</option>
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
            placeholder="Ej: Fuerza Inferior"
          />
        </label>

        <label className="ek-label" style={{ marginTop: '14px' }}>
          Enfoque (opcional)
          <input
            type="text"
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            className="ek-input"
            placeholder="Ej: Piernas + Cardio HIIT"
          />
          <span className="ek-helper-text">
            Lo que se trabaja ese día. Es lo que distingue una clase de otra cuando comparten sala.
          </span>
        </label>

        <label className="ek-label" style={{ marginTop: '14px' }}>
          Disciplina (opcional)
          <input
            type="text"
            value={disciplina}
            onChange={(e) => setDisciplina(e.target.value)}
            className="ek-input"
            placeholder="Ej: Fuerza"
          />
          <span className="ek-helper-text">
            Si la dejás vacía, se usa la de la sala.
          </span>
        </label>

        <div className="ek-form-field" style={{ marginTop: '14px' }}>
          <label className="ek-label">Foto de la clase (opcional)</label>
          <ImageUploader
            bucket="estudios"
            pathPrefix={`${tenant.slug}/clase-${horario?.id ?? 'nueva'}`}
            currentUrl={fotoUrl}
            onUploaded={(url) => setFotoUrl(url)}
            label="Imagen de esta clase"
            previewMaxHeight={160}
            helperText="Si no subís una, se usa la foto de la sala. Con una sola sala, todas las clases se verían con la misma imagen."
          />
        </div>

        {/* La identidad es de la CLASE, no de la franja: sin esto, cambiar la foto
            de una clase con 10 franjas obligaba a editar las 10 a mano. */}
        {hermanas.length > 0 && (
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              marginTop: '14px',
              padding: '12px 14px',
              borderRadius: '10px',
              background: 'var(--sala-primary-light)',
              border: '0.5px solid var(--sala-border)',
              cursor: 'pointer'
            }}
          >
            <input
              type="checkbox"
              checked={aplicarATodas}
              onChange={(e) => setAplicarATodas(e.target.checked)}
              style={{ marginTop: '2px', accentColor: 'var(--sala-primary)' }}
            />
            <span>
              <span style={{ display: 'block', fontWeight: 600, fontSize: '13px' }}>
                Aplicar a las otras {hermanas.length} franjas de “{horario!.nombre}”
              </span>
              <span style={{ display: 'block', fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '2px', lineHeight: 1.45 }}>
                El nombre, el enfoque, la disciplina y la foto se copian a todas las horas de esta
                misma clase. La hora, los días y el cupo de cada franja no se tocan.
              </span>
            </span>
          </label>
        )}

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
            description="Al desactivarlo se detiene la generación de nuevas clases. Las clases ya generadas siguen en la Agenda — cancelalas desde ahí si quieres."
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
