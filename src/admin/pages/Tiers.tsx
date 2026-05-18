import { useEffect, useMemo, useState } from 'react';
import { useTiersAdmin, updateTier, insertTier } from '../hooks/useAdminData';
import {
  archiveRecord,
  restoreRecord,
  generateUniqueSlug,
  countActiveMembersInTier,
  canHardDeleteTier,
  hardDeleteRecord
} from '../lib/crudHelpers';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import Toggle from '../components/Toggle';
import ConfirmDialog from '../components/ConfirmDialog';
import CardMenuDropdown from '../components/CardMenuDropdown';
import type { Database } from '@shared/types/database';

type Tier = Database['public']['Tables']['tiers']['Row'];

type ModalState =
  | { mode: 'edit'; tier: Tier }
  | { mode: 'create' }
  | null;

type ArchivarState =
  | null
  | { tier: Tier; status: 'loading' }
  | { tier: Tier; status: 'ready'; activeMembers: number };

type HardDeleteTierState =
  | null
  | { tier: Tier; status: 'loading' }
  | { tier: Tier; status: 'blocked'; reason: string }
  | { tier: Tier; status: 'ready' };

export default function Tiers() {
  const tenant = useTenant();
  const toast = useToast();
  const { tiers, isLoading, refetch } = useTiersAdmin();
  const [modal, setModal] = useState<ModalState>(null);
  const [archivar, setArchivar] = useState<ArchivarState>(null);
  const [borrarPerm, setBorrarPerm] = useState<HardDeleteTierState>(null);
  const [mostrarArchivados, setMostrarArchivados] = useState(false);
  const [duplicandoId, setDuplicandoId] = useState<string | null>(null);
  const [restaurandoId, setRestaurandoId] = useState<string | null>(null);

  const { activos, archivados } = useMemo(() => {
    return {
      activos: tiers.filter((t) => t.activo),
      archivados: tiers.filter((t) => !t.activo)
    };
  }, [tiers]);

  async function handleDuplicar(original: Tier) {
    setDuplicandoId(original.id);
    const existingSlugs = tiers.map((t) => t.slug);
    const nuevoSlug = generateUniqueSlug(original.slug, existingSlugs);

    const { error } = await insertTier({
      tenant_id: tenant.id,
      slug: nuevoSlug,
      nombre: `(copia) ${original.nombre}`,
      descripcion: original.descripcion,
      precio_centavos: original.precio_centavos,
      moneda: original.moneda,
      periodo: original.periodo,
      beneficios: original.beneficios,
      reglas: original.reglas,
      // stripe_price_id: NULL — NUNCA duplicar referencias externas únicas
      stripe_price_id: null,
      activo: true,
      orden: (original.orden ?? 0) + 1
    });

    setDuplicandoId(null);
    if (error) {
      toast.error(`No se pudo duplicar: ${error}`);
      return;
    }
    toast.success('Plan duplicado.');
    await refetch();
  }

  async function startArchivar(tier: Tier) {
    setArchivar({ tier, status: 'loading' });
    const count = await countActiveMembersInTier({
      tierId: tier.id,
      tierSlug: tier.slug,
      tenantId: tenant.id
    });
    setArchivar({ tier, status: 'ready', activeMembers: count });
  }

  async function handleArchivar() {
    if (!archivar || archivar.status !== 'ready' || archivar.activeMembers > 0) return;
    const { error } = await archiveRecord('tiers', archivar.tier.id);
    if (error) {
      toast.error(`No se pudo eliminar: ${error}`);
      return;
    }
    setArchivar(null);
    toast.success('Plan eliminado. Lo encuentras en "Ver eliminados".');
    await refetch();
  }

  async function handleRestaurar(t: Tier) {
    setRestaurandoId(t.id);
    const { error } = await restoreRecord('tiers', t.id);
    setRestaurandoId(null);
    if (error) {
      toast.error(`No se pudo recuperar: ${error}`);
      return;
    }
    toast.success('Plan recuperado.');
    await refetch();
  }

  async function startHardDelete(t: Tier) {
    setBorrarPerm({ tier: t, status: 'loading' });
    const check = await canHardDeleteTier(t.id);
    if (!check.canDelete) {
      setBorrarPerm({ tier: t, status: 'blocked', reason: check.reason ?? 'No se puede eliminar.' });
    } else {
      setBorrarPerm({ tier: t, status: 'ready' });
    }
  }

  async function handleHardDelete() {
    if (!borrarPerm || borrarPerm.status !== 'ready') return;
    const { error } = await hardDeleteRecord('tiers', borrarPerm.tier.id);
    if (error) {
      toast.error(`No se pudo eliminar permanentemente: ${error.message}`);
      return;
    }
    setBorrarPerm(null);
    toast.success('Plan eliminado permanentemente.');
    await refetch();
  }

  const archivarTier = archivar?.tier;
  const archivarBloqueado = archivar?.status === 'ready' && archivar.activeMembers > 0;
  const archivarConfirmDescription = (() => {
    if (!archivar) return '';
    if (archivar.status === 'loading') return 'Verificando miembros activos…';
    if (archivar.activeMembers > 0) {
      return `${archivar.activeMembers} miembro(s) activo(s) tienen este plan. Migralos a otro plan antes de eliminar este.`;
    }
    return 'Este plan se moverá a Eliminados: deja de aparecer en signup y landing. Los miembros existentes con este plan no se afectan. Lo puedes recuperar después.';
  })();

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">PLANES</p>
          <h1 className="ek-h2">Tus membresías disponibles</h1>
          {!isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
              {activos.length} {activos.length === 1 ? 'activo' : 'activos'}
              {' · '}
              {archivados.length} {archivados.length === 1 ? 'eliminado' : 'eliminados'}
            </p>
          )}
        </div>
        <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
          + Nueva membresía
        </button>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <>
          <div className="adm-stack">
            {activos.length === 0 ? (
              <p className="ek-body-faint" style={{ padding: '20px 0' }}>
                No hay planes activos. Click en &quot;+ Nueva membresía&quot; para crear el primero.
              </p>
            ) : (
              activos.map((t) => (
                <TierRow
                  key={t.id}
                  tier={t}
                  tenantId={tenant.id}
                  onEdit={() => setModal({ mode: 'edit', tier: t })}
                  onDuplicate={() => handleDuplicar(t)}
                  onArchive={() => startArchivar(t)}
                  duplicating={duplicandoId === t.id}
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
                {mostrarArchivados ? '▾' : '▸'} Ver eliminados ({archivados.length})
              </button>

              {mostrarArchivados && (
                <div className="adm-stack" style={{ opacity: 0.6 }}>
                  {archivados.map((t) => (
                    <TierArchivedRow
                      key={t.id}
                      tier={t}
                      onRestore={() => handleRestaurar(t)}
                      onHardDelete={() => startHardDelete(t)}
                      restoring={restaurandoId === t.id}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {modal?.mode === 'edit' && (
        <EditarTierModal
          tier={modal.tier}
          existingSlugs={tiers.map((t) => t.slug)}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await refetch();
            setModal(null);
          }}
        />
      )}

      {modal?.mode === 'create' && (
        <EditarTierModal
          tier={null}
          existingSlugs={tiers.map((t) => t.slug)}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await refetch();
            setModal(null);
          }}
        />
      )}

      <ConfirmDialog
        isOpen={archivar !== null}
        title={archivarTier ? `¿Eliminar “${archivarTier.nombre}”?` : ''}
        description={archivarConfirmDescription}
        confirmLabel="Eliminar"
        variant={archivarBloqueado ? 'danger' : 'warning'}
        hideConfirm={archivarBloqueado || archivar?.status === 'loading'}
        onConfirm={handleArchivar}
        onCancel={() => setArchivar(null)}
      />

      <ConfirmDialog
        isOpen={borrarPerm !== null}
        title={borrarPerm ? `¿Eliminar permanentemente “${borrarPerm.tier.nombre}”?` : ''}
        description={
          borrarPerm?.status === 'loading'
            ? 'Verificando miembros vinculados…'
            : borrarPerm?.status === 'blocked'
            ? borrarPerm.reason
            : 'Esta acción NO se puede deshacer. El plan será borrado permanentemente de la base de datos.'
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

function useMemberCount(tier: Tier, tenantId: string): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    countActiveMembersInTier({ tierId: tier.id, tierSlug: tier.slug, tenantId }).then((n) => {
      if (mounted) setCount(n);
    });
    return () => { mounted = false; };
  }, [tier.id, tier.slug, tenantId]);

  return count;
}

function TierRow({
  tier: t,
  tenantId,
  onEdit,
  onDuplicate,
  onArchive,
  duplicating
}: {
  tier: Tier;
  tenantId: string;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  duplicating: boolean;
}) {
  const memberCount = useMemberCount(t, tenantId);
  const esPro = t.slug === 'pro';
  const beneficios = parseBeneficios(t.beneficios);
  const compromiso = ((t.reglas as Record<string, unknown> | null)?.commitment_meses ?? null) as number | null;

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
        background: 'var(--ek-bg-soft)',
        border: esPro ? '0.5px solid var(--ek-mustard-dim)' : '0.5px solid var(--ek-line)',
        borderRadius: '16px',
        padding: '20px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '16px',
        cursor: 'pointer',
        transition: 'background 0.18s ease, border-color 0.18s ease',
        boxShadow: esPro ? '0 0 0 1px var(--ek-mustard-dim)' : 'none'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--ek-mustard-soft)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--ek-bg-soft)';
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px', flexWrap: 'wrap' }}>
          <h3
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '20px',
              fontWeight: 600,
              margin: 0,
              color: 'var(--ek-ink)',
              letterSpacing: '-0.02em'
            }}
          >
            {t.nombre}
          </h3>
          {esPro && (
            <span
              className="ek-badge"
              style={{
                backgroundColor: 'var(--ek-mustard-soft)',
                color: 'var(--ek-mustard)',
                fontSize: '10px',
                fontWeight: 700,
                padding: '3px 8px',
                letterSpacing: '0.05em'
              }}
            >
              ★ RECOMENDADO
            </span>
          )}
        </div>
        <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '8px' }}>
          ${(t.precio_centavos / 100).toLocaleString('es-MX')} {t.moneda}/{t.periodo}
          {compromiso ? ` · ${compromiso} meses de compromiso` : ''}
        </p>
        {beneficios.slice(0, 3).length > 0 && (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: '0 0 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px'
            }}
          >
            {beneficios.slice(0, 3).map((b) => (
              <li
                key={b}
                style={{
                  fontSize: '13px',
                  color: 'var(--ek-ink-muted)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '6px'
                }}
              >
                <span style={{ color: 'var(--ek-mustard)' }}>•</span>
                <span style={{ flex: 1 }}>{b}</span>
              </li>
            ))}
            {beneficios.length > 3 && (
              <li style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginLeft: '12px' }}>…</li>
            )}
          </ul>
        )}
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: 0 }}>
          {memberCount === null
            ? 'Cargando…'
            : memberCount === 0
            ? 'Sin miembros activos'
            : `${memberCount} ${memberCount === 1 ? 'miembro activo' : 'miembros activos'}`}
        </p>
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

function TierArchivedRow({
  tier: t,
  onRestore,
  onHardDelete,
  restoring
}: {
  tier: Tier;
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
        padding: '20px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        opacity: 0.6
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '18px',
            fontWeight: 600,
            margin: 0,
            marginBottom: '4px',
            color: 'var(--ek-ink)',
            textDecoration: 'line-through',
            letterSpacing: '-0.02em'
          }}
        >
          {t.nombre}
        </h3>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: 0 }}>
          Eliminado · slug: {t.slug} · ${(t.precio_centavos / 100).toLocaleString('es-MX')} {t.moneda}
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

function parseBeneficios(raw: unknown): string[] {
  try {
    if (Array.isArray(raw)) return raw.filter((b): b is string => typeof b === 'string');
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((b): b is string => typeof b === 'string')
        : [];
    }
    return [];
  } catch {
    return [];
  }
}

function EditarTierModal({
  tier,
  existingSlugs,
  onClose,
  onSaved
}: {
  tier: Tier | null;
  existingSlugs: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const tenant = useTenant();
  const esCreacion = tier === null;

  const [slug, setSlug] = useState(tier?.slug ?? '');
  const [nombre, setNombre] = useState(tier?.nombre ?? '');
  const [precio, setPrecio] = useState(
    tier ? String(tier.precio_centavos / 100) : ''
  );
  const [descripcion, setDescripcion] = useState(tier?.descripcion ?? '');
  const [activo, setActivo] = useState(tier?.activo ?? true);
  const [beneficios, setBeneficios] = useState<string[]>(() =>
    tier ? parseBeneficios(tier.beneficios) : []
  );
  const [maxInvitados, setMaxInvitados] = useState<number>(() => {
    const reglas = tier?.reglas as Record<string, unknown> | null;
    const raw = reglas?.max_invitados;
    if (typeof raw === 'number') return raw;
    return tier?.slug === 'pro' ? 4 : 2;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validación inline del slug (modo crear)
  const slugFormatValido = slug === '' || /^[a-z0-9-]+$/.test(slug);
  const slugChocaConOtro = esCreacion && slug !== '' && existingSlugs.includes(slug);

  async function handleSave() {
    setSaving(true);
    setError(null);

    const precioCentavos = Math.round(parseFloat(precio) * 100);
    if (!Number.isFinite(precioCentavos) || precioCentavos < 0) {
      setError('Precio inválido.');
      setSaving(false);
      return;
    }

    if (esCreacion) {
      if (!slug.trim()) {
        setError('El slug es obligatorio.');
        setSaving(false);
        return;
      }
      if (!/^[a-z0-9-]+$/.test(slug)) {
        setError('Slug inválido. Solo minúsculas, números y guiones.');
        setSaving(false);
        return;
      }
      if (existingSlugs.includes(slug)) {
        setError(`Ya existe un tier con slug "${slug}". Usá otro.`);
        setSaving(false);
        return;
      }
      if (!nombre.trim()) {
        setError('El nombre es obligatorio.');
        setSaving(false);
        return;
      }

      const reglas = { max_invitados: maxInvitados };

      const { error: err } = await insertTier({
        tenant_id: tenant.id,
        slug,
        nombre: nombre.trim(),
        descripcion: descripcion || null,
        precio_centavos: precioCentavos,
        moneda: 'MXN',
        periodo: 'mensual',
        beneficios: beneficios as never,
        reglas: reglas as never,
        activo,
        orden: existingSlugs.length + 1
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
    const reglasActuales = (tier!.reglas as Record<string, unknown>) ?? {};
    const reglasNuevas = { ...reglasActuales, max_invitados: maxInvitados };

    const { error: err } = await updateTier(tier!.id, {
      nombre,
      descripcion: descripcion || null,
      precio_centavos: precioCentavos,
      beneficios,
      reglas: reglasNuevas as never,
      activo
    });

    if (err) {
      setError(err);
      setSaving(false);
      return;
    }
    await onSaved();
  }

  return (
    <div className="adm-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow ek-eyebrow--mustard">
          {esCreacion ? 'NUEVA MEMBRESÍA' : 'EDITAR PLAN'}
        </p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>
          {nombre || (esCreacion ? 'Sin nombre' : tier!.nombre)}
        </h3>

        {esCreacion && (
          <div className="ek-form-field">
            <label className="ek-label">Slug (identificador)</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="ek-input"
              placeholder="basica, pro, premium..."
              pattern="[a-z0-9-]+"
            />
            <p
              style={{
                fontSize: '11px',
                color: !slugFormatValido || slugChocaConOtro
                  ? 'var(--ek-danger)'
                  : 'var(--ek-ink-faint)',
                marginTop: '6px'
              }}
            >
              {!slugFormatValido
                ? 'Solo minúsculas, números y guiones.'
                : slugChocaConOtro
                ? `Ya existe un tier con slug "${slug}".`
                : 'Identificador único, NO editable después. Usado en URLs y en BD.'}
            </p>
          </div>
        )}

        <label className="ek-label">
          Nombre
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} className="ek-input" />
        </label>

        <label className="ek-label">
          Descripción
          <input
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            className="ek-input"
          />
        </label>

        <label className="ek-label">
          Precio (MXN)
          <input
            type="number"
            step="0.01"
            value={precio}
            onChange={(e) => setPrecio(e.target.value)}
            className="ek-input"
          />
        </label>

        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <Toggle
            checked={activo}
            onChange={setActivo}
            label="Plan activo"
            description="Si está inactivo, no se puede asignar a nuevos miembros."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Máximo de invitados por sesión</label>
          <input
            type="number"
            min={0}
            max={10}
            value={maxInvitados}
            onChange={(e) => setMaxInvitados(parseInt(e.target.value) || 0)}
            className="ek-input"
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Cantidad de invitados adicionales que el miembro puede traer a cada sesión (no
            incluye al titular). El RPC de reservas valida este número.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Beneficios del plan</label>
          <BeneficiosEditor value={beneficios} onChange={setBeneficios} />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Lista de beneficios que se muestran al miembro en la landing y signup.
          </p>
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
          <button onClick={handleSave} disabled={saving} className="ek-cta" style={{ flex: 1 }}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BeneficiosEditor({
  value,
  onChange
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [nuevo, setNuevo] = useState('');

  const agregar = () => {
    const trim = nuevo.trim();
    if (!trim) return;
    onChange([...value, trim]);
    setNuevo('');
  };

  const eliminar = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const editar = (idx: number, nuevoTexto: string) => {
    onChange(value.map((b, i) => (i === idx ? nuevoTexto : b)));
  };

  const mover = (idx: number, dir: 'up' | 'down') => {
    const newIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= value.length) return;
    const newArr = [...value];
    [newArr[idx], newArr[newIdx]] = [newArr[newIdx], newArr[idx]];
    onChange(newArr);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '16px',
        background: 'var(--ek-bg-soft)',
        borderRadius: 'var(--ek-r-md)',
        border: '0.5px solid var(--ek-line)'
      }}
    >
      {value.length === 0 && (
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', fontStyle: 'italic' }}>
          Sin beneficios. Agrega el primero abajo.
        </p>
      )}

      {value.map((beneficio, idx) => (
        <div
          key={idx}
          style={{
            display: 'grid',
            gridTemplateColumns: '24px 1fr auto auto auto',
            gap: '8px',
            alignItems: 'center',
            padding: '8px',
            background: 'var(--ek-bg-elevated)',
            borderRadius: 'var(--ek-r-sm)'
          }}
        >
          <span style={{ color: 'var(--ek-mustard)', textAlign: 'center', fontSize: '14px' }}>
            ✓
          </span>

          <input
            type="text"
            value={beneficio}
            onChange={(e) => editar(idx, e.target.value)}
            className="ek-input"
            style={{ fontSize: '13px', padding: '6px 10px' }}
          />

          <button
            type="button"
            onClick={() => mover(idx, 'up')}
            disabled={idx === 0}
            className="ek-icon-btn"
            style={{ padding: '4px 8px', fontSize: '12px', opacity: idx === 0 ? 0.3 : 1 }}
            aria-label="Subir"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => mover(idx, 'down')}
            disabled={idx === value.length - 1}
            className="ek-icon-btn"
            style={{
              padding: '4px 8px',
              fontSize: '12px',
              opacity: idx === value.length - 1 ? 0.3 : 1
            }}
            aria-label="Bajar"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => eliminar(idx)}
            className="ek-icon-btn"
            style={{ padding: '4px 8px', fontSize: '12px', color: 'var(--ek-danger)' }}
            aria-label="Eliminar"
          >
            ✕
          </button>
        </div>
      ))}

      <div
        style={{
          display: 'flex',
          gap: '8px',
          paddingTop: '8px',
          borderTop: '0.5px dashed var(--ek-line)'
        }}
      >
        <input
          type="text"
          placeholder="Ej: Acceso a TODOS los estudios"
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
          style={{ padding: '8px 16px', fontSize: '12px', whiteSpace: 'nowrap' }}
        >
          + Agregar
        </button>
      </div>
    </div>
  );
}
