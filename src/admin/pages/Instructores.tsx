import { useState } from 'react';
import { X } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';
import { useToast } from '@shared/hooks/useToast';
import {
  useInstructores,
  crearInstructor,
  actualizarInstructor,
  type Instructor,
  type InstructorFormData
} from '../hooks/useInstructores';
import Toggle from '../components/Toggle';
import ImageUploader from '../components/ImageUploader';

type ModalState = { mode: 'edit'; instructor: Instructor } | { mode: 'create' } | null;

const BIO_MAX = 300;

export default function Instructores() {
  const { instructores, isLoading, refetch } = useInstructores();
  const [modal, setModal] = useState<ModalState>(null);

  const activos = instructores.filter((i) => i.activo);
  const inactivos = instructores.filter((i) => !i.activo);

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">INSTRUCTORES</p>
          <h1 className="ek-h2">Tu equipo de instructores</h1>
          {!isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
              {activos.length} {activos.length === 1 ? 'activo' : 'activos'}
              {inactivos.length > 0 && ` · ${inactivos.length} ${inactivos.length === 1 ? 'inactivo' : 'inactivos'}`}
            </p>
          )}
        </div>
        <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
          + Nuevo instructor
        </button>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : instructores.length === 0 ? (
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
              margin: 0,
              marginBottom: '8px'
            }}
          >
            Sin instructores
          </p>
          <h3
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '18px',
              fontWeight: 600,
              color: 'var(--sala-text-primary)',
              margin: 0,
              marginBottom: '14px'
            }}
          >
            Todavía no cargaste instructores.
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '20px' }}>
            Agregá el primero para poder asignarlo a las clases.
          </p>
          <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
            + Nuevo instructor
          </button>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '14px'
          }}
        >
          {instructores.map((i) => (
            <InstructorCard
              key={i.id}
              instructor={i}
              onEdit={() => setModal({ mode: 'edit', instructor: i })}
            />
          ))}
        </div>
      )}

      {modal && (
        <InstructorModal
          instructor={modal.mode === 'edit' ? modal.instructor : null}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await refetch();
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Card
// ============================================================================

function iniciales(nombre: string): string {
  return (
    nombre
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

function InstructorCard({ instructor: i, onEdit }: { instructor: Instructor; onEdit: () => void }) {
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
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '16px',
        padding: '16px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        opacity: i.activo ? 1 : 0.6,
        transition: 'border-color 0.18s ease, transform 0.12s ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--sala-primary)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--sala-border)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {i.foto_url ? (
          <img
            src={i.foto_url}
            alt={i.nombre}
            style={{
              width: '52px',
              height: '52px',
              borderRadius: '50%',
              objectFit: 'cover',
              flexShrink: 0,
              border: '1px solid var(--sala-border)'
            }}
          />
        ) : (
          <span
            style={{
              width: '52px',
              height: '52px',
              borderRadius: '50%',
              background: 'var(--sala-primary)',
              color: 'var(--sala-text-on-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--ek-font-display)',
              fontSize: '18px',
              fontWeight: 700,
              flexShrink: 0
            }}
          >
            {iniciales(i.nombre)}
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '16px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--sala-text-primary)',
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {i.nombre}
          </h3>
          <span
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: i.activo ? 'var(--sala-success)' : 'var(--sala-text-tertiary)'
            }}
          >
            {i.activo ? 'Activo' : 'Inactivo'}
          </span>
        </div>
      </div>

      {i.especialidades.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {i.especialidades.map((e) => (
            <span
              key={e}
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--sala-primary)',
                background: 'var(--sala-primary-light)',
                padding: '3px 9px',
                borderRadius: '999px'
              }}
            >
              {e}
            </span>
          ))}
        </div>
      )}

      {i.bio && (
        <p
          style={{
            fontSize: '12px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          {i.bio}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Modal crear / editar
// ============================================================================

function InstructorModal({
  instructor,
  onClose,
  onSaved
}: {
  instructor: Instructor | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const tenant = useTenant();
  const { sucursalId } = useSucursal();
  const toast = useToast();
  const esCreacion = instructor === null;

  const [nombre, setNombre] = useState(instructor?.nombre ?? '');
  const [rol, setRol] = useState(instructor?.rol ?? '');
  const [bio, setBio] = useState(instructor?.bio ?? '');
  const [fotoUrl, setFotoUrl] = useState(instructor?.foto_url ?? '');
  const [especialidades, setEspecialidades] = useState<string[]>(
    instructor?.especialidades ?? []
  );
  const [activo, setActivo] = useState(instructor?.activo ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const photoPrefix = `instructores/${tenant.slug}/${instructor?.id ?? `nuevo-${Date.now()}`}`;

  async function handleSave() {
    setError(null);
    if (!nombre.trim()) {
      setError('El nombre es obligatorio.');
      return;
    }
    if (bio.length > BIO_MAX) {
      setError(`La bio no puede superar ${BIO_MAX} caracteres.`);
      return;
    }
    if (esCreacion && !sucursalId) {
      setError('No hay una sucursal activa. Recargá la página.');
      return;
    }

    const data: InstructorFormData = {
      nombre: nombre.trim(),
      rol: rol.trim() || null,
      bio: bio.trim() || null,
      foto_url: fotoUrl || null,
      especialidades,
      activo
    };

    setSaving(true);
    const { error: err } = esCreacion
      ? await crearInstructor(tenant.id, sucursalId!, data)
      : await actualizarInstructor(instructor!.id, data);
    setSaving(false);

    if (err) {
      setError('No pudimos guardar el instructor. Probá de nuevo.');
      return;
    }
    toast.success(esCreacion ? 'Instructor creado' : 'Instructor actualizado');
    await onSaved();
  }

  return (
    <div className="adm-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow ek-eyebrow--mustard">
          {esCreacion ? 'NUEVO INSTRUCTOR' : 'EDITAR INSTRUCTOR'}
        </p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>
          {nombre || 'Sin nombre'}
        </h3>

        <div style={{ marginBottom: '16px' }}>
          <ImageUploader
            bucket="estudios"
            pathPrefix={photoPrefix}
            currentUrl={fotoUrl || null}
            onUploaded={setFotoUrl}
            label="Foto del instructor"
            cropAspect={3 / 4}
            helperText="JPG, PNG o WEBP. Máx 5MB. Vas a poder recortarla (vertical) al subirla."
          />
        </div>

        <label className="ek-label">
          Nombre
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="ek-input"
            placeholder="Ej: María Fernanda Ríos"
          />
        </label>

        <label className="ek-label" style={{ marginTop: '14px' }}>
          Rol
          <input
            type="text"
            value={rol}
            onChange={(e) => setRol(e.target.value)}
            className="ek-input"
            placeholder="Ej: Coach de cycling"
          />
          <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
            Aparece bajo el nombre en el detalle de la clase del socio.
          </span>
        </label>

        <label className="ek-label" style={{ marginTop: '14px' }}>
          Bio
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="ek-input"
            rows={3}
            maxLength={BIO_MAX}
            placeholder="Breve descripción: experiencia, estilo, certificaciones…"
          />
          <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
            {bio.length}/{BIO_MAX}
          </span>
        </label>

        <div className="ek-form-field" style={{ marginTop: '14px' }}>
          <label className="ek-label">Especialidades</label>
          <ChipInput
            value={especialidades}
            onChange={setEspecialidades}
            placeholder="Ej: Yoga, Spinning, Crossfit…"
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '14px' }}>
          <Toggle
            checked={activo}
            onChange={setActivo}
            label="Instructor activo"
            description="Si está inactivo, no aparece para asignar a clases nuevas."
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

// ============================================================================
// Chip input para especialidades
// ============================================================================

function ChipInput({
  value,
  onChange,
  placeholder
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [nuevo, setNuevo] = useState('');

  const agregar = () => {
    const trim = nuevo.trim();
    if (!trim || value.includes(trim)) {
      setNuevo('');
      return;
    }
    onChange([...value, trim]);
    setNuevo('');
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px',
        background: 'var(--ek-bg-soft)',
        borderRadius: 'var(--ek-r-md)',
        border: '0.5px solid var(--ek-line)'
      }}
    >
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {value.map((item) => (
            <span
              key={item}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--sala-primary)',
                background: 'var(--sala-primary-light)',
                padding: '4px 10px',
                borderRadius: '999px'
              }}
            >
              {item}
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== item))}
                aria-label={`Quitar ${item}`}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--sala-primary)',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: 0,
                  lineHeight: 1,
                  fontFamily: 'inherit'
                }}
              >
                <X size={14} strokeWidth={2.5} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          type="text"
          value={nuevo}
          onChange={(e) => setNuevo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              agregar();
            }
          }}
          className="ek-input"
          placeholder={placeholder}
          style={{ flex: 1, fontSize: '13px' }}
        />
        <button
          type="button"
          onClick={agregar}
          className="ek-cta"
          style={{ padding: '8px 14px', fontSize: '12px', whiteSpace: 'nowrap' }}
        >
          + Agregar
        </button>
      </div>
    </div>
  );
}
