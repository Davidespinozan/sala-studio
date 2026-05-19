import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { useRecursosAdmin, updateRecurso, insertRecurso } from '../hooks/useAdminData';
import {
  archiveRecord,
  restoreRecord,
  generateUniqueSlug,
  canHardDeleteRecurso,
  hardDeleteRecord
} from '../lib/crudHelpers';
import Toggle from '../components/Toggle';
import ImageUploader from '../components/ImageUploader';
import ConfirmDialog from '../components/ConfirmDialog';
import CardMenuDropdown from '../components/CardMenuDropdown';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type RecursoInsert = Database['public']['Tables']['recursos']['Insert'];

// Estado del modal: 'edit' lleva una fila existente; 'create' lleva los defaults.
type ModalState =
  | { mode: 'edit'; recurso: Recurso }
  | { mode: 'create' }
  | null;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

interface BloqueHorario {
  dia: string;
  inicio: string;
  fin: string;
}

interface TierOption {
  slug: string;
  nombre: string;
}

const DIAS = [
  { key: 'lunes', label: 'Lunes' },
  { key: 'martes', label: 'Martes' },
  { key: 'miercoles', label: 'Miércoles' },
  { key: 'jueves', label: 'Jueves' },
  { key: 'viernes', label: 'Viernes' },
  { key: 'sabado', label: 'Sábado' },
  { key: 'domingo', label: 'Domingo' }
] as const;

function useTiersDelTenant(): TierOption[] {
  const tenant = useTenant();
  const [tiers, setTiers] = useState<TierOption[]>([]);

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (error) {
        console.error('[useTiersDelTenant]', error);
        setTiers([
          { slug: 'basica', nombre: 'Básica' },
          { slug: 'pro', nombre: 'Pro' }
        ]);
      } else {
        setTiers(data ?? []);
      }
    }
    load();
  }, [tenant.id]);

  return tiers;
}

type HardDeleteState =
  | null
  | { recurso: Recurso; status: 'loading' }
  | { recurso: Recurso; status: 'blocked'; reason: string }
  | { recurso: Recurso; status: 'ready' };

export default function Recursos() {
  const tenant = useTenant();
  const toast = useToast();
  const { recursos, isLoading, refetch } = useRecursosAdmin();
  const [modal, setModal] = useState<ModalState>(null);
  const [archivando, setArchivando] = useState<Recurso | null>(null);
  const [borrarPerm, setBorrarPerm] = useState<HardDeleteState>(null);
  const [mostrarArchivados, setMostrarArchivados] = useState(false);
  const [duplicandoId, setDuplicandoId] = useState<string | null>(null);
  const [restaurandoId, setRestaurandoId] = useState<string | null>(null);

  const { activos, archivados } = useMemo(() => {
    return {
      activos: recursos.filter((r) => r.activo),
      archivados: recursos.filter((r) => !r.activo)
    };
  }, [recursos]);

  async function handleDuplicar(original: Recurso) {
    setDuplicandoId(original.id);
    const existingSlugs = recursos.map((r) => r.slug);
    const nuevoSlug = generateUniqueSlug(original.slug, existingSlugs);

    const payload: RecursoInsert = {
      tenant_id: tenant.id,
      slug: nuevoSlug,
      nombre: `(copia) ${original.nombre}`,
      descripcion: original.descripcion,
      tipo: original.tipo,
      cupos: original.cupos,
      capacidad_personas: original.capacidad_personas,
      horarios: original.horarios,
      tiers_permitidos: original.tiers_permitidos,
      equipo_incluido: original.equipo_incluido,
      tipo_contenido: original.tipo_contenido,
      estilo_visual: original.estilo_visual,
      foto_url: null, // no copiar la foto (puede confundir; admin sube nueva si quiere)
      activo: true,
      orden: (original.orden ?? 0) + 1
    };

    const { error } = await insertRecurso(payload);
    setDuplicandoId(null);
    if (error) {
      toast.error('No pudimos duplicar la sala. Probá de nuevo.');
      return;
    }
    toast.success('Sala duplicada.');
    await refetch();
  }

  async function handleArchivar() {
    if (!archivando) return;
    const { error } = await archiveRecord('recursos', archivando.id);
    if (error) {
      toast.error('No pudimos eliminarla. Probá de nuevo.');
      return;
    }
    setArchivando(null);
    toast.success('Sala eliminada. La encontrás en "Ver eliminadas".');
    await refetch();
  }

  async function handleRestaurar(r: Recurso) {
    setRestaurandoId(r.id);
    const { error } = await restoreRecord('recursos', r.id);
    setRestaurandoId(null);
    if (error) {
      toast.error('No pudimos recuperarla. Probá de nuevo.');
      return;
    }
    toast.success('Sala recuperada.');
    await refetch();
  }

  async function startHardDelete(r: Recurso) {
    setBorrarPerm({ recurso: r, status: 'loading' });
    const check = await canHardDeleteRecurso(r.id);
    if (!check.canDelete) {
      setBorrarPerm({ recurso: r, status: 'blocked', reason: check.reason ?? 'No se puede eliminar.' });
    } else {
      setBorrarPerm({ recurso: r, status: 'ready' });
    }
  }

  async function handleHardDelete() {
    if (!borrarPerm || borrarPerm.status !== 'ready') return;
    const { error } = await hardDeleteRecord('recursos', borrarPerm.recurso.id);
    if (error) {
      toast.error('No pudimos eliminarla permanentemente. Probá de nuevo.');
      return;
    }
    setBorrarPerm(null);
    toast.success('Sala eliminada permanentemente.');
    await refetch();
  }

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">SALAS</p>
          <h1 className="ek-h2">Tus espacios reservables</h1>
          {!isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
              {activos.length} {activos.length === 1 ? 'activa' : 'activas'}
              {' · '}
              {archivados.length} {archivados.length === 1 ? 'eliminada' : 'eliminadas'}
            </p>
          )}
        </div>
        <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
          + Nueva sala
        </button>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <>
          <div className="adm-stack">
            {activos.length === 0 ? (
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
                  Sin salas todavía
                </p>
                <h3
                  style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: '18px',
                    fontWeight: 600,
                    letterSpacing: '-0.02em',
                    color: 'var(--sala-text-primary)',
                    margin: 0,
                    marginBottom: '14px'
                  }}
                >
                  Todavía no creaste salas.
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '20px' }}>
                  Agregá la primera para empezar a programar clases.
                </p>
                <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
                  + Nueva sala
                </button>
              </div>
            ) : (
              activos.map((r) => (
                <RecursoRow
                  key={r.id}
                  recurso={r}
                  onEdit={() => setModal({ mode: 'edit', recurso: r })}
                  onDuplicate={() => handleDuplicar(r)}
                  onArchive={() => setArchivando(r)}
                  duplicating={duplicandoId === r.id}
                />
              ))
            )}
          </div>

          {archivados.length > 0 && (
            <section style={{ marginTop: '32px' }}>
              <button
                type="button"
                onClick={() => setMostrarArchivados((v) => !v)}
                className="ek-icon-btn"
                style={{
                  width: 'auto',
                  padding: '8px 14px',
                  fontSize: '12px',
                  marginBottom: '12px'
                }}
              >
                {mostrarArchivados ? '▾' : '▸'} Ver eliminadas ({archivados.length})
              </button>

              {mostrarArchivados && (
                <div className="adm-stack" style={{ opacity: 0.6 }}>
                  {archivados.map((r) => (
                    <RecursoArchivedRow
                      key={r.id}
                      recurso={r}
                      onRestore={() => handleRestaurar(r)}
                      onHardDelete={() => startHardDelete(r)}
                      restoring={restaurandoId === r.id}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {modal?.mode === 'edit' && (
        <EditarRecursoModal
          recurso={modal.recurso}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await refetch();
            setModal(null);
          }}
        />
      )}

      {modal?.mode === 'create' && (
        <EditarRecursoModal
          recurso={null}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await refetch();
            setModal(null);
          }}
        />
      )}

      <ConfirmDialog
        isOpen={archivando !== null}
        title={archivando ? `¿Eliminar “${archivando.nombre}”?` : ''}
        description="Esta sala se moverá a Eliminadas: deja de aparecer en la landing y no se podrá reservar, pero las reservas históricas se conservan. La podés recuperar después."
        confirmLabel="Eliminar"
        variant="warning"
        onConfirm={handleArchivar}
        onCancel={() => setArchivando(null)}
      />

      <ConfirmDialog
        isOpen={borrarPerm !== null}
        title={borrarPerm ? `¿Eliminar permanentemente “${borrarPerm.recurso.nombre}”?` : ''}
        description={
          borrarPerm?.status === 'loading'
            ? 'Verificando reservas vinculadas…'
            : borrarPerm?.status === 'blocked'
            ? borrarPerm.reason
            : 'Esta acción NO se puede deshacer. La sala será borrada permanentemente de la base de datos.'
        }
        confirmLabel="Eliminar permanentemente"
        variant="danger"
        hideConfirm={borrarPerm?.status !== 'ready'}
        requireTypedConfirmation={borrarPerm?.status === 'ready' ? 'ELIMINAR' : undefined}
        onConfirm={handleHardDelete}
        onCancel={() => setBorrarPerm(null)}
      />
    </div>
  );
}

/** Indicador compacto de días de operación: 7 dots Lun-Dom.
 *  Día con bloques → salvia sólido. Día sin bloques → border-only muted. */
function DiasIndicator({ bloques }: { bloques: BloqueHorario[] }) {
  const diasActivos = new Set(bloques.map((b) => b.dia));
  const totalBloques = bloques.length;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '3px' }}>
        {DIAS.map((dia) => {
          const activo = diasActivos.has(dia.key);
          return (
            <span
              key={dia.key}
              title={`${dia.label}${activo ? '' : ' (cerrado)'}`}
              style={{
                width: '14px',
                height: '14px',
                borderRadius: '4px',
                background: activo ? 'var(--sala-primary)' : 'transparent',
                border: `1px solid ${activo ? 'var(--sala-primary)' : 'var(--sala-border-strong)'}`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '8px',
                fontWeight: 700,
                color: activo ? 'var(--sala-text-on-primary)' : 'var(--sala-text-tertiary)',
                letterSpacing: 0
              }}
            >
              {dia.label.charAt(0)}
            </span>
          );
        })}
      </div>
      {totalBloques > 0 && (
        <span style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
          {totalBloques} {totalBloques === 1 ? 'bloque' : 'bloques'}
        </span>
      )}
    </div>
  );
}

function FotoThumb({ url, alt }: { url: string | null; alt: string }) {
  return (
    <div
      style={{
        width: '120px',
        height: '120px',
        flexShrink: 0,
        background: 'var(--ek-bg-elevated)',
        borderRadius: '12px',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '4px',
            color: 'var(--ek-ink-faint)'
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          <span style={{ fontSize: '10px', letterSpacing: '0.1em' }}>SIN FOTO</span>
        </div>
      )}
    </div>
  );
}

function RecursoRow({
  recurso: r,
  onEdit,
  onDuplicate,
  onArchive,
  duplicating
}: {
  recurso: Recurso;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  duplicating: boolean;
}) {
  const equipo = (r.equipo_incluido ?? []).slice(0, 3).join(', ');
  const equipoMas = (r.equipo_incluido?.length ?? 0) > 3 ? '…' : '';
  const contenido = (r.tipo_contenido ?? []).join(' / ');
  const horariosBloques = parseHorarios(r.horarios);

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
        padding: '14px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        cursor: 'pointer',
        transition: 'background 0.18s ease, border-color 0.18s ease, transform 0.12s ease',
        boxShadow: '0 1px 3px rgba(26, 31, 28, 0.04)'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--sala-primary-light)';
        e.currentTarget.style.borderColor = 'var(--sala-primary)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--sala-surface)';
        e.currentTarget.style.borderColor = 'var(--sala-border)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <FotoThumb url={r.foto_url} alt={r.nombre} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '18px',
            fontWeight: 600,
            margin: 0,
            marginBottom: '6px',
            color: 'var(--sala-text-primary)',
            letterSpacing: '-0.02em'
          }}
        >
          {r.nombre}
        </h3>
        {contenido && (
          <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '2px' }}>
            {contenido}
          </p>
        )}
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '2px' }}>
          Cupo: {r.cupo_max_default} por clase
        </p>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '4px' }}>
          Plan: {r.tiers_permitidos.join(', ') || '—'}
        </p>
        <DiasIndicator bloques={horariosBloques} />
        {equipo && (
          <p
            style={{
              fontSize: '12px',
              color: 'var(--sala-text-tertiary)',
              margin: '4px 0 0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {equipo}{equipoMas}
          </p>
        )}
      </div>
      <CardMenuDropdown
        items={[
          { label: 'Editar', icon: '✏️', onClick: onEdit },
          { label: duplicating ? 'Duplicando…' : 'Duplicar', icon: '📋', onClick: onDuplicate, disabled: duplicating },
          { label: 'Eliminar', icon: '🗑', onClick: onArchive, danger: true, divider: true }
        ]}
      />
    </div>
  );
}

function RecursoArchivedRow({
  recurso: r,
  onRestore,
  onHardDelete,
  restoring
}: {
  recurso: Recurso;
  onRestore: () => void;
  onHardDelete: () => void;
  restoring: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--ek-bg-soft)',
        border: '0.5px solid var(--ek-line)',
        borderRadius: '16px',
        padding: '14px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        opacity: 0.6
      }}
    >
      <FotoThumb url={r.foto_url} alt={r.nombre} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '17px',
            fontWeight: 600,
            margin: 0,
            marginBottom: '4px',
            color: 'var(--ek-ink)',
            textDecoration: 'line-through',
            letterSpacing: '-0.02em'
          }}
        >
          {r.nombre}
        </h3>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: 0 }}>
          Eliminado · slug: {r.slug}
        </p>
      </div>
      <CardMenuDropdown
        items={[
          { label: restoring ? 'Recuperando…' : 'Recuperar', icon: '♻️', onClick: onRestore, disabled: restoring },
          { label: 'Eliminar permanentemente', icon: '⚠️', onClick: onHardDelete, danger: true, divider: true }
        ]}
      />
    </div>
  );
}

function parseHorarios(raw: unknown): BloqueHorario[] {
  try {
    if (Array.isArray(raw)) return raw as BloqueHorario[];
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
    return [];
  } catch {
    return [];
  }
}

function EditarRecursoModal({
  recurso,
  onClose,
  onSaved
}: {
  recurso: Recurso | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const tenant = useTenant();
  const tiersDisponibles = useTiersDelTenant();
  const esCreacion = recurso === null;

  const [nombre, setNombre] = useState(recurso?.nombre ?? '');
  const [slug, setSlug] = useState(recurso?.slug ?? '');
  const [slugTocado, setSlugTocado] = useState(!esCreacion);
  const [descripcion, setDescripcion] = useState(recurso?.descripcion ?? '');
  const [activo, setActivo] = useState(recurso?.activo ?? true);
  const [tiersPermitidos, setTiersPermitidos] = useState<string[]>(
    recurso?.tiers_permitidos ?? []
  );
  const [horarios, setHorarios] = useState<BloqueHorario[]>(() =>
    parseHorarios(recurso?.horarios)
  );
  const [fotoUrl, setFotoUrl] = useState<string>(recurso?.foto_url ?? '');
  const [cupoMaxDefault, setCupoMaxDefault] = useState<number>(
    recurso?.cupo_max_default ?? 12
  );
  const [tipoContenido, setTipoContenido] = useState<string[]>(recurso?.tipo_contenido ?? []);
  const [equipoIncluido, setEquipoIncluido] = useState<string[]>(recurso?.equipo_incluido ?? []);
  const [estiloVisual, setEstiloVisual] = useState<string>(recurso?.estilo_visual ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Slug auto-derivado del nombre en modo crear, hasta que el admin lo edite manualmente
  useEffect(() => {
    if (esCreacion && !slugTocado) {
      setSlug(slugify(nombre));
    }
  }, [nombre, esCreacion, slugTocado]);

  async function handleSave() {
    setSaving(true);
    setError(null);

    if (horariosTienenError(horarios)) {
      setError('Hay horarios inválidos. Revisá las marcas en rojo (fin debe ser mayor a inicio, sin solapamientos).');
      setSaving(false);
      return;
    }

    if (!Number.isInteger(cupoMaxDefault) || cupoMaxDefault < 1) {
      setError('El cupo máximo por clase debe ser un número entero de al menos 1.');
      setSaving(false);
      return;
    }

    if (esCreacion) {
      if (!nombre.trim()) {
        setError('El nombre es obligatorio.');
        setSaving(false);
        return;
      }
      const slugFinal = slug.trim() || slugify(nombre);
      if (!/^[a-z0-9-]+$/.test(slugFinal)) {
        setError('El slug solo puede contener letras minúsculas, números y guiones.');
        setSaving(false);
        return;
      }

      const { error: err } = await insertRecurso({
        tenant_id: tenant.id,
        slug: slugFinal,
        nombre: nombre.trim(),
        descripcion: descripcion || null,
        tipo: 'estudio_individual',
        cupos: 1,
        cupo_max_default: cupoMaxDefault,
        activo,
        tiers_permitidos: tiersPermitidos,
        horarios: horarios as never,
        foto_url: fotoUrl || null,
        tipo_contenido: tipoContenido,
        equipo_incluido: equipoIncluido,
        estilo_visual: estiloVisual || null
      });

      if (err) {
        setError(err);
        setSaving(false);
        return;
      }
      await onSaved();
      return;
    }

    // Edit mode
    const { error: err } = await updateRecurso(recurso!.id, {
      nombre,
      descripcion: descripcion || null,
      activo,
      tiers_permitidos: tiersPermitidos,
      horarios: horarios as never,
      cupo_max_default: cupoMaxDefault,
      foto_url: fotoUrl || null,
      tipo_contenido: tipoContenido,
      equipo_incluido: equipoIncluido,
      estilo_visual: estiloVisual || null
    });

    if (err) {
      setError(err);
      setSaving(false);
      return;
    }
    await onSaved();
  }

  // Path prefix para upload de foto: usa el slug si existe, sino "nuevo-{timestamp}".
  // En modo crear, si el admin sube foto antes de tener slug definitivo, no se mueve.
  const photoSlug = slug || `nuevo-${Date.now()}`;

  return (
    <div className="adm-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow ek-eyebrow--mustard">
          {esCreacion ? 'NUEVA SALA' : 'EDITAR SALA'}
        </p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>
          {nombre || 'Sin nombre'}
        </h3>

        <label className="ek-label">
          Nombre
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="ek-input"
            placeholder="Ej: Sala Yoga"
          />
        </label>

        {esCreacion && (
          <div className="ek-form-field">
            <label className="ek-label">Slug (URL)</label>
            <input
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTocado(true);
              }}
              className="ek-input"
              placeholder="sala-yoga"
              pattern="[a-z0-9-]+"
            />
            <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
              Solo minúsculas, números y guiones. Identificador único, no editable luego.
            </p>
          </div>
        )}

        <label className="ek-label">
          Descripción
          <input
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            className="ek-input"
          />
        </label>

        <div className="ek-form-field">
          <label className="ek-label">Planes con acceso a esta sala</label>
          <MultiSelectTiers
            options={tiersDisponibles}
            value={tiersPermitidos}
            onChange={setTiersPermitidos}
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Solo los miembros con estos planes podrán reservar esta sala.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <Toggle
            checked={activo}
            onChange={setActivo}
            label="Sala activa"
            description="Si está inactiva, no aparece en la lista de reservables del miembro."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Horarios de operación</label>
          <HorariosEditor value={horarios} onChange={setHorarios} />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Define los días y horas en que esta sala puede reservarse.
          </p>
        </div>

        <div style={{ marginTop: '16px' }}>
          <ImageUploader
            bucket="estudios"
            pathPrefix={`${tenant.slug}/${photoSlug}`}
            currentUrl={fotoUrl || null}
            onUploaded={setFotoUrl}
            label="Foto de la sala"
            helperText="JPG, PNG o WEBP. Máx 5MB. Aspecto 16:10 recomendado."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Cupo máximo por clase</label>
          <input
            type="number"
            min={1}
            step={1}
            value={cupoMaxDefault || ''}
            onChange={(e) => setCupoMaxDefault(parseInt(e.target.value, 10) || 0)}
            className="ek-input"
            placeholder="12"
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Cuántas personas caben en cada clase de esta sala. Aplica a clases futuras.
            Para cambiar una clase específica, editala desde la Agenda.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Tipos de clase recomendados</label>
          <ListaEditable
            value={tipoContenido}
            onChange={setTipoContenido}
            placeholder="Ej: Yoga, Spinning, Crossfit..."
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Tags que ayudan a los miembros a elegir la sala adecuada.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Equipo incluido</label>
          <ListaEditable
            value={equipoIncluido}
            onChange={setEquipoIncluido}
            placeholder="Ej: Colchonetas, mancuernas..."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Estilo visual</label>
          <textarea
            value={estiloVisual}
            onChange={(e) => setEstiloVisual(e.target.value)}
            className="ek-input"
            rows={3}
            placeholder="Describe el ambiente, iluminación, decoración..."
          />
        </div>

        {error && <p className="ek-error-text">{error}</p>}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button
            onClick={onClose}
            disabled={saving}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Devuelve true si algún bloque tiene fin <= inicio o overlaps dentro del mismo día. */
export function horariosTienenError(value: BloqueHorario[]): boolean {
  for (const dia of DIAS) {
    const bloques = value
      .filter((b) => b.dia === dia.key)
      .sort((a, b) => a.inicio.localeCompare(b.inicio));
    for (let i = 0; i < bloques.length; i++) {
      const b = bloques[i];
      if (b.fin <= b.inicio) return true;
      // overlap con siguiente?
      if (i + 1 < bloques.length && bloques[i + 1].inicio < b.fin) return true;
    }
  }
  return false;
}

function HorariosEditor({
  value,
  onChange
}: {
  value: BloqueHorario[];
  onChange: (v: BloqueHorario[]) => void;
}) {
  const bloquesDia = (diaKey: string) =>
    value
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.dia === diaKey)
      .sort((a, b) => a.b.inicio.localeCompare(b.b.inicio));

  const setActivo = (diaKey: string, activo: boolean) => {
    if (activo) {
      if (bloquesDia(diaKey).length === 0) {
        onChange([...value, { dia: diaKey, inicio: '09:00', fin: '12:00' }]);
      }
    } else {
      onChange(value.filter((b) => b.dia !== diaKey));
    }
  };

  const agregarBloque = (diaKey: string) => {
    const bloques = bloquesDia(diaKey).map(({ b }) => b);
    // Sugerir un bloque después del último, o uno default
    const ultimo = bloques[bloques.length - 1];
    const inicio = ultimo?.fin ?? '17:00';
    const finDefault = inicio < '20:00' ? '20:00' : '22:00';
    onChange([...value, { dia: diaKey, inicio, fin: finDefault }]);
  };

  const eliminarBloque = (originalIdx: number) => {
    onChange(value.filter((_, i) => i !== originalIdx));
  };

  const updateBloque = (originalIdx: number, campo: 'inicio' | 'fin', val: string) => {
    onChange(value.map((b, i) => (i === originalIdx ? { ...b, [campo]: val } : b)));
  };

  const tieneOverlap = (diaKey: string, originalIdx: number, inicio: string, fin: string) => {
    return value.some(
      (b, i) =>
        i !== originalIdx &&
        b.dia === diaKey &&
        inicio < b.fin &&
        fin > b.inicio
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '16px',
        background: 'var(--sala-bg)',
        borderRadius: '14px',
        border: '1px solid var(--sala-border)'
      }}
    >
      {DIAS.map((dia) => {
        const bloques = bloquesDia(dia.key);
        const activo = bloques.length > 0;

        return (
          <div
            key={dia.key}
            style={{
              padding: '12px 14px',
              background: activo ? 'var(--sala-primary-light)' : 'var(--sala-surface)',
              borderRadius: '12px',
              border: `1px solid ${activo ? 'rgba(61, 107, 82, 0.20)' : 'var(--sala-border)'}`,
              transition: 'background 0.18s ease, border-color 0.18s ease'
            }}
          >
            {/* Header del día */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  cursor: 'pointer',
                  flex: 1
                }}
              >
                <input
                  type="checkbox"
                  checked={activo}
                  onChange={(e) => setActivo(dia.key, e.target.checked)}
                  style={{ width: '18px', height: '18px', accentColor: 'var(--sala-primary)', cursor: 'pointer' }}
                />
                <span
                  style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: '15px',
                    fontWeight: 600,
                    color: activo ? 'var(--sala-text-primary)' : 'var(--sala-text-tertiary)'
                  }}
                >
                  {dia.label}
                </span>
                {!activo && (
                  <span style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', fontStyle: 'italic' }}>
                    Cerrado
                  </span>
                )}
              </label>
            </div>

            {/* Bloques del día */}
            {activo && (
              <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {bloques.map(({ b, i: originalIdx }) => {
                  const invalidRango = b.fin <= b.inicio;
                  const invalidOverlap = tieneOverlap(dia.key, originalIdx, b.inicio, b.fin);
                  const invalid = invalidRango || invalidOverlap;
                  return (
                    <div
                      key={originalIdx}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 16px 1fr 40px',
                        gap: '8px',
                        alignItems: 'center',
                        padding: '6px 8px',
                        background: 'var(--sala-surface)',
                        border: `1px solid ${invalid ? 'var(--sala-accent)' : 'var(--sala-border)'}`,
                        borderRadius: '10px'
                      }}
                    >
                      <input
                        type="time"
                        value={b.inicio}
                        onChange={(e) => updateBloque(originalIdx, 'inicio', e.target.value)}
                        style={{
                          fontSize: '13px',
                          padding: '8px 10px',
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--sala-text-primary)',
                          fontFamily: 'var(--ek-font-mono)',
                          fontVariantNumeric: 'tabular-nums'
                        }}
                      />
                      <span style={{ color: 'var(--sala-text-tertiary)', textAlign: 'center', fontSize: '12px' }}>
                        —
                      </span>
                      <input
                        type="time"
                        value={b.fin}
                        onChange={(e) => updateBloque(originalIdx, 'fin', e.target.value)}
                        style={{
                          fontSize: '13px',
                          padding: '8px 10px',
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--sala-text-primary)',
                          fontFamily: 'var(--ek-font-mono)',
                          fontVariantNumeric: 'tabular-nums'
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => eliminarBloque(originalIdx)}
                        aria-label="Eliminar bloque"
                        title="Eliminar bloque"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--sala-text-tertiary)',
                          fontSize: '16px',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          padding: '6px',
                          borderRadius: '6px',
                          transition: 'color 0.18s ease'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--sala-accent)')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--sala-text-tertiary)')}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}

                {/* Mensajes de validación */}
                {bloques.some(
                  ({ b, i }) =>
                    b.fin <= b.inicio || tieneOverlap(dia.key, i, b.inicio, b.fin)
                ) && (
                  <p style={{ fontSize: '11px', color: 'var(--sala-accent)', margin: '2px 0 0', fontWeight: 600 }}>
                    Hay bloques inválidos (fin debe ser mayor a inicio, sin solapamientos).
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => agregarBloque(dia.key)}
                  style={{
                    alignSelf: 'flex-start',
                    background: 'transparent',
                    color: 'var(--sala-primary)',
                    border: '1px dashed var(--sala-primary)',
                    borderRadius: '999px',
                    padding: '6px 14px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    marginTop: '4px'
                  }}
                >
                  + Agregar bloque
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ListaEditable({
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
    if (!trim) return;
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {value.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 10px',
                background: 'var(--ek-bg-elevated)',
                borderRadius: 'var(--ek-r-sm)'
              }}
            >
              <span style={{ color: 'var(--ek-mustard)', fontSize: '12px' }}>✓</span>
              <span style={{ flex: 1, fontSize: '13px' }}>{item}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, i) => i !== idx))}
                className="ek-icon-btn"
                style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--ek-danger)' }}
                aria-label="Eliminar"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          type="text"
          placeholder={placeholder}
          value={nuevo}
          onChange={(e) => setNuevo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              agregar();
            }
          }}
          className="ek-input"
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

function MultiSelectTiers({
  options,
  value,
  onChange
}: {
  options: TierOption[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (slug: string) => {
    if (value.includes(slug)) {
      onChange(value.filter((s) => s !== slug));
    } else {
      onChange([...value, slug]);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '12px',
        background: 'var(--ek-bg-soft)',
        borderRadius: 'var(--ek-r-md)',
        border: '0.5px solid var(--ek-line)'
      }}
    >
      {options.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)' }}>
          Todavía no hay planes. Creá uno en "Planes" para asociarlo a esta sala.
        </p>
      ) : (
        options.map((opt) => {
          const selected = value.includes(opt.slug);
          return (
            <button
              key={opt.slug}
              type="button"
              onClick={() => toggle(opt.slug)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                background: selected ? 'var(--ek-mustard-soft)' : 'var(--ek-bg-elevated)',
                border: `0.5px solid ${selected ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                borderRadius: 'var(--ek-r-md)',
                color: selected ? 'var(--ek-mustard)' : 'var(--ek-ink)',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.18s ease'
              }}
            >
              <span style={{ fontSize: '14px' }}>{selected ? '✓' : '○'}</span>
              {opt.nombre}
            </button>
          );
        })
      )}
    </div>
  );
}
