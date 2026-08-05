import { useEffect, useMemo, useState } from 'react';
import { Pencil, Copy, Trash2, ChevronDown, ChevronRight, Star, Check, ArrowUp, ArrowDown, X, RotateCcw } from 'lucide-react';
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
import { useSucursal } from '../providers/SucursalProvider';
import Toggle from '../components/Toggle';
import ConfirmDialog from '../components/ConfirmDialog';
import CardMenuDropdown from '../components/CardMenuDropdown';
import type { Database } from '@shared/types/database';

type Tier = Database['public']['Tables']['tiers']['Row'];

// Monedas soportadas (código ISO en mayúsculas, compatible con Intl). El símbolo
// es solo para el selector; el formateo real usa Intl con el código.
const MONEDA_OPTS: { value: string; label: string }[] = [
  { value: 'MXN', label: 'MXN · peso mexicano' },
  { value: 'USD', label: 'USD · dólar' },
  { value: 'EUR', label: 'EUR · euro' }
];
// Duraciones de acceso para el modelo por tiempo. El motor guarda duracion_dias
// (cualquier número); estas son las opciones comunes + "personalizada".
const DURACION_OPTS: { value: string; label: string }[] = [
  { value: '7', label: '1 semana (7 días)' },
  { value: '15', label: 'Quincena (15 días)' },
  { value: '30', label: '1 mes (30 días)' },
  { value: '90', label: '3 meses (90 días)' },
  { value: '365', label: '1 año (365 días)' },
  { value: 'custom', label: 'Otra duración…' }
];

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
      acceso_todas_sucursales: original.acceso_todas_sucursales,
      // stripe_price_id: NULL — NUNCA duplicar referencias externas únicas
      stripe_price_id: null,
      activo: true,
      orden: (original.orden ?? 0) + 1
    });

    setDuplicandoId(null);
    if (error) {
      toast.error('No pudimos duplicar el plan. Prueba de nuevo.');
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
      toast.error('No pudimos eliminar el plan. Prueba de nuevo.');
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
      toast.error('No pudimos recuperar el plan. Prueba de nuevo.');
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
      toast.error('No pudimos eliminarlo permanentemente. Prueba de nuevo.');
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
      return `${archivar.activeMembers} miembro(s) activo(s) tienen este plan. Cámbialos de plan antes de eliminar este.`;
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
          + Nuevo plan
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
                  Sin planes todavía
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
                  No tienes planes definidos.
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '20px' }}>
                  Crea uno para empezar a cobrar membresías.
                </p>
                <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
                  + Nuevo plan
                </button>
              </div>
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
                  marginBottom: '12px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px'
                }}
              >
                {mostrarArchivados ? <ChevronDown size={14} strokeWidth={2.25} /> : <ChevronRight size={14} strokeWidth={2.25} />}
                Ver eliminados ({archivados.length})
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
  // Editable desde el form (reglas.recomendado). Compat: si un gym viejo nunca
  // lo marcó, cae al histórico 'pro' hasta que el dueño elija otro.
  const esRecomendado =
    ((t.reglas as Record<string, unknown> | null)?.recomendado as boolean | undefined) ??
    (t.slug === 'pro');
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
        border: esRecomendado ? '0.5px solid var(--sala-accent-dim)' : '0.5px solid var(--ek-line)',
        borderRadius: '16px',
        padding: '20px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '16px',
        cursor: 'pointer',
        transition: 'background 0.18s ease, border-color 0.18s ease',
        boxShadow: esRecomendado ? '0 0 0 1px var(--sala-accent-dim)' : 'none'
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
          {esRecomendado && (
            <span
              className="ek-badge"
              style={{
                backgroundColor: 'var(--sala-accent-soft)',
                color: 'var(--sala-accent)',
                fontSize: '10px',
                fontWeight: 700,
                padding: '3px 8px',
                letterSpacing: '0.05em',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px'
              }}
            >
              <Star size={11} strokeWidth={2.5} fill="currentColor" />
              RECOMENDADO
            </span>
          )}
        </div>
        <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '8px' }}>
          ${(t.precio_centavos / 100).toLocaleString('es-MX')} {t.moneda}
          {t.tipo === 'creditos' || t.tipo === 'hibrido'
            ? ` · ${t.clases_incluidas ?? 0} clases${t.tipo === 'hibrido' && t.duracion_dias ? ` · vencen en ${t.duracion_dias} días` : ''}`
            : `/${t.periodo}`}
          {compromiso && t.tipo === 'tiempo' ? ` · ${compromiso} meses de compromiso` : ''}
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
          { label: 'Editar', icon: <Pencil size={15} />, onClick: onEdit },
          { label: duplicating ? 'Duplicando…' : 'Duplicar', icon: <Copy size={15} />, onClick: onDuplicate, disabled: duplicating },
          { label: 'Eliminar', icon: <Trash2 size={15} />, onClick: onArchive, danger: true, divider: true }
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
          { label: restoring ? 'Recuperando…' : 'Recuperar', icon: <RotateCcw size={15} strokeWidth={2} />, onClick: onRestore, disabled: restoring },
          { label: 'Eliminar permanentemente', icon: <Trash2 size={15} strokeWidth={2} />, onClick: onHardDelete, danger: true, divider: true }
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
  const { multisede } = useSucursal();
  const esCreacion = tier === null;

  const [slug, setSlug] = useState(tier?.slug ?? '');
  const [nombre, setNombre] = useState(tier?.nombre ?? '');
  const [precio, setPrecio] = useState(
    tier ? String(tier.precio_centavos / 100) : ''
  );
  const [moneda, setMoneda] = useState(tier?.moneda ?? 'MXN');
  // periodo ya no se elige a mano en el modelo por tiempo (se deriva de la
  // duración); para paquetes queda el valor inicial. Solo se lee.
  const [periodo] = useState(tier?.periodo ?? 'mensual');
  const [descripcion, setDescripcion] = useState(tier?.descripcion ?? '');
  const [activo, setActivo] = useState(tier?.activo ?? true);
  const [accesoTodasSucursales, setAccesoTodasSucursales] = useState(
    tier?.acceso_todas_sucursales ?? true
  );
  const [recomendado, setRecomendado] = useState<boolean>(
    ((tier?.reglas as Record<string, unknown> | null)?.recomendado as boolean | undefined) ??
      (tier?.slug === 'pro') // compat: 'pro' era el recomendado por defecto
  );
  const [beneficios, setBeneficios] = useState<string[]>(() =>
    tier ? parseBeneficios(tier.beneficios) : []
  );
  // Pases de invitado incluidos en cada periodo del plan (bolsa, no techo por
  // clase). 0 = el plan no permite invitados.
  const [invitadosPorPeriodo, setInvitadosPorPeriodo] = useState<number>(
    () => tier?.invitados_por_periodo ?? 0
  );
  // Visible en landing / vendible a socios nuevos. Apagarlo NO afecta el acceso
  // de quienes YA lo tienen (a diferencia de archivar).
  const [enVenta, setEnVenta] = useState<boolean>(
    () => (tier as { en_venta?: boolean } | null)?.en_venta ?? true
  );
  // Cuota única de alta. Se cobra una sola vez por socio.
  const [inscripcion, setInscripcion] = useState<string>(
    () => ((tier?.inscripcion_centavos ?? 0) / 100).toString()
  );
  // Modelo de plan: mensualidad (tiempo) o paquete de clases (creditos/hibrido).
  const [esPaquete, setEsPaquete] = useState<boolean>(
    () => tier?.tipo === 'creditos' || tier?.tipo === 'hibrido'
  );
  const [clasesIncluidas, setClasesIncluidas] = useState<string>(
    () => (tier?.clases_incluidas != null ? String(tier.clases_incluidas) : '10')
  );
  const [vence, setVence] = useState<boolean>(() => tier?.tipo === 'hibrido');
  const [duracionDias, setDuracionDias] = useState<string>(
    () => (tier?.duracion_dias != null ? String(tier.duracion_dias) : '30')
  );
  // Duración del acceso (modelo por tiempo): preset o 'custom'.
  const [duracionSel, setDuracionSel] = useState<string>(() => {
    const d = tier?.duracion_dias;
    if (d == null) return '30';
    return ['7', '15', '30', '90', '365'].includes(String(d)) ? String(d) : 'custom';
  });
  // Pago único: el plan por tiempo NO es una suscripción autorenovable.
  const [pagoUnico, setPagoUnico] = useState<boolean>(() => (tier as { pago_unico?: boolean } | null)?.pago_unico === true);
  // Días de acceso (0=dom … 6=sáb). Vacío = todos los días (sin restricción).
  const tierDias = (tier as { dias_acceso?: number[] | null } | null)?.dias_acceso;
  const [limitarDias, setLimitarDias] = useState<boolean>(() => Array.isArray(tierDias) && tierDias.length > 0);
  const [diasAcceso, setDiasAcceso] = useState<number[]>(() => (Array.isArray(tierDias) && tierDias.length > 0 ? tierDias : [1, 2, 3, 4, 5]));
  // Máx. reservas por día ('' = sin tope).
  const [maxReservasDia, setMaxReservasDia] = useState<string>(() => {
    const m = (tier as { max_reservas_dia?: number | null } | null)?.max_reservas_dia;
    return m != null ? String(m) : '';
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

    const inscripcionCentavos = Math.round(parseFloat(inscripcion || '0') * 100);
    if (!Number.isFinite(inscripcionCentavos) || inscripcionCentavos < 0) {
      setError('Inscripción inválida.');
      setSaving(false);
      return;
    }

    // Modelo de plan → tipo + clases + vigencia.
    const tipo = !esPaquete ? 'tiempo' : vence ? 'hibrido' : 'creditos';
    const clasesVal = esPaquete ? Math.round(Number(clasesIncluidas)) : null;

    // Duración del acceso. Paquete: la vigencia (si vence). Por tiempo: el preset
    // o el valor personalizado (cualquier número de días).
    let duracionVal: number | null;
    let periodoFinal = periodo;
    if (esPaquete) {
      duracionVal = vence ? Math.round(Number(duracionDias)) : null;
    } else {
      const dias = duracionSel === 'custom' ? Math.round(Number(duracionDias)) : Number(duracionSel);
      if (!Number.isFinite(dias) || dias < 1) {
        setError('La duración del acceso debe ser de al menos 1 día.');
        setSaving(false);
        return;
      }
      duracionVal = dias;
      // periodo es solo etiqueta/ciclo de cobro online; se deriva de la duración
      // (numa cobra en recepción, no lo usa). duracion_dias es la fuente de verdad.
      periodoFinal = dias <= 15 ? 'quincenal' : dias >= 180 ? 'anual' : 'mensual';
    }
    // Un plan por tiempo de pago único no es suscripción; el paquete ya es de pago
    // único por naturaleza, así que el flag solo aplica al modelo por tiempo.
    const pagoUnicoVal = !esPaquete ? pagoUnico : false;

    // Días de acceso: vacío/apagado = todos los días (null).
    if (limitarDias && diasAcceso.length === 0) {
      setError('Elige al menos un día de acceso.');
      setSaving(false);
      return;
    }
    const diasAccesoVal = limitarDias && diasAcceso.length > 0 ? [...diasAcceso].sort((a, b) => a - b) : null;

    // Máx. reservas por día ('' = sin tope; mínimo 1).
    const maxResVal = maxReservasDia.trim() ? Math.max(1, Math.round(Number(maxReservasDia))) : null;
    if (maxReservasDia.trim() && (!Number.isFinite(maxResVal as number))) {
      setError('El máximo de reservas por día no es válido.');
      setSaving(false);
      return;
    }

    if (esPaquete && (!Number.isFinite(clasesVal as number) || (clasesVal ?? 0) < 1)) {
      setError('El paquete debe incluir al menos 1 clase.');
      setSaving(false);
      return;
    }
    if (esPaquete && vence && (!Number.isFinite(duracionVal as number) || (duracionVal ?? 0) < 1)) {
      setError('La vigencia debe ser de al menos 1 día.');
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
        setError(`Ya existe un plan con slug "${slug}". Usa otro.`);
        setSaving(false);
        return;
      }
      if (!nombre.trim()) {
        setError('El nombre es obligatorio.');
        setSaving(false);
        return;
      }

      const reglas = { recomendado };

      const { error: err } = await insertTier({
        tenant_id: tenant.id,
        slug,
        nombre: nombre.trim(),
        descripcion: descripcion || null,
        precio_centavos: precioCentavos,
        inscripcion_centavos: inscripcionCentavos,
        invitados_por_periodo: invitadosPorPeriodo,
        en_venta: enVenta,
        moneda,
        periodo: periodoFinal,
        tipo,
        clases_incluidas: clasesVal,
        duracion_dias: duracionVal,
        pago_unico: pagoUnicoVal,
        dias_acceso: diasAccesoVal,
        max_reservas_dia: maxResVal,
        beneficios: beneficios as never,
        reglas: reglas as never,
        activo,
        acceso_todas_sucursales: accesoTodasSucursales,
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
    const reglasNuevas = { ...reglasActuales, recomendado };

    const { error: err } = await updateTier(tier!.id, {
      nombre,
      descripcion: descripcion || null,
      precio_centavos: precioCentavos,
      inscripcion_centavos: inscripcionCentavos,
      invitados_por_periodo: invitadosPorPeriodo,
      en_venta: enVenta,
      moneda,
      periodo: periodoFinal,
      tipo,
      clases_incluidas: clasesVal,
      duracion_dias: duracionVal,
      pago_unico: pagoUnicoVal,
      dias_acceso: diasAccesoVal,
      max_reservas_dia: maxResVal,
      beneficios,
      reglas: reglasNuevas as never,
      activo,
      acceso_todas_sucursales: accesoTodasSucursales
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
          {esCreacion ? 'NUEVO PLAN' : 'EDITAR PLAN'}
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
                ? `Ya existe un plan con slug "${slug}".`
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

        {/* Modelo de plan: mensualidad (tiempo) vs paquete de clases (créditos). */}
        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <label className="ek-label" style={{ display: 'block', marginBottom: '6px' }}>Modelo de plan</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={() => setEsPaquete(false)}
              className={!esPaquete ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
              style={{ flex: 1, minHeight: 38 }}
            >
              Mensualidad
            </button>
            <button
              type="button"
              onClick={() => setEsPaquete(true)}
              className={esPaquete ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
              style={{ flex: 1, minHeight: 38 }}
            >
              Paquete de clases
            </button>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '6px 0 0', lineHeight: 1.5 }}>
            {esPaquete
              ? 'El socio compra N clases (pago único). Cada reserva descuenta una.'
              : pagoUnico
                ? 'Acceso ilimitado por un tiempo. Pago único: el socio renueva cuando vuelve a pagar.'
                : 'Acceso ilimitado por tiempo, con cobro recurrente.'}
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
          <label className="ek-label">
            Precio ({moneda})
            <input
              type="number"
              step="0.01"
              value={precio}
              onChange={(e) => setPrecio(e.target.value)}
              className="ek-input"
            />
          </label>
          <label className="ek-label">
            Moneda
            <select value={moneda} onChange={(e) => setMoneda(e.target.value)} className="ek-input">
              {MONEDA_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {!esPaquete ? (
            <label className="ek-label">
              Duración del acceso
              <select value={duracionSel} onChange={(e) => setDuracionSel(e.target.value)} className="ek-input">
                {DURACION_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="ek-label">
              Nº de clases
              <input
                type="number"
                min="1"
                step="1"
                value={clasesIncluidas}
                onChange={(e) => setClasesIncluidas(e.target.value)}
                className="ek-input"
              />
            </label>
          )}
        </div>

        {/* Duración personalizada (modelo por tiempo): cualquier número de días. */}
        {!esPaquete && duracionSel === 'custom' && (
          <label className="ek-label" style={{ display: 'block', marginTop: '10px' }}>
            Duración en días
            <input
              type="number"
              min="1"
              step="1"
              value={duracionDias}
              onChange={(e) => setDuracionDias(e.target.value)}
              className="ek-input"
            />
          </label>
        )}

        {/* Pago único: el plan por tiempo no es suscripción autorenovable. */}
        {!esPaquete && (
          <div className="ek-form-field" style={{ marginTop: '12px' }}>
            <Toggle
              checked={pagoUnico}
              onChange={setPagoUnico}
              label="Pago único (no se renueva sola)"
              description="El socio paga una vez por su acceso; para seguir, vuelve a pagar (ideal si cobras en recepción). Sin auto-cobro."
            />
          </div>
        )}

        {/* Tope de reservas por día. Vacío = sin límite. */}
        <label className="ek-label" style={{ marginTop: '12px', display: 'block' }}>
          Máx. reservas por día (opcional)
          <input
            type="number"
            min="1"
            step="1"
            value={maxReservasDia}
            onChange={(e) => setMaxReservasDia(e.target.value)}
            className="ek-input"
            placeholder="Sin límite"
          />
          <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
            Cuántas clases puede reservar el socio en un mismo día. Vacío = sin tope.
          </span>
        </label>

        {/* Acceso por día de la semana: si se limita, el sistema bloquea reservar
            en días no permitidos (ej. Elevate lun-vie, Ultra lun-sáb). */}
        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <Toggle
            checked={limitarDias}
            onChange={setLimitarDias}
            label="Limitar días de acceso"
            description="Si lo prendes, el socio de este plan solo puede reservar los días que elijas. Apagado = todos los días."
          />
          {limitarDias && (
            <div style={{ display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' }}>
              {[
                [1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']
              ].map(([n, l]) => {
                const activo = diasAcceso.includes(n as number);
                return (
                  <button
                    key={n as number}
                    type="button"
                    onClick={() => setDiasAcceso((d) => (d.includes(n as number) ? d.filter((x) => x !== n) : [...d, n as number]))}
                    className={activo ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
                    style={{ minHeight: 34, padding: '4px 12px', fontSize: 13 }}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {esPaquete && (
          <div className="ek-form-field" style={{ marginTop: '12px' }}>
            <Toggle
              checked={vence}
              onChange={setVence}
              label="Las clases vencen"
              description="Si está activo, el paquete caduca a los X días de la compra."
            />
            {vence && (
              <label className="ek-label" style={{ display: 'block', marginTop: '10px' }}>
                Vigencia (días)
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={duracionDias}
                  onChange={(e) => setDuracionDias(e.target.value)}
                  className="ek-input"
                />
              </label>
            )}
          </div>
        )}

        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <Toggle
            checked={activo}
            onChange={setActivo}
            label="Plan activo"
            description="Si está inactivo, no se puede asignar a nuevos miembros."
          />
        </div>

        {multisede && (
          <div className="ek-form-field" style={{ marginTop: '12px' }}>
            <Toggle
              checked={accesoTodasSucursales}
              onChange={setAccesoTodasSucursales}
              label="Acceso a todas las sedes"
              description="Si está activo, el plan sirve en cualquier sucursal. Si lo apagas, el miembro solo puede reservar en la sede a la que se suscribió."
            />
          </div>
        )}

        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <Toggle
            checked={recomendado}
            onChange={setRecomendado}
            label="Destacar como recomendado"
            description="Resalta este plan con el badge RECOMENDADO en la lista de planes."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Inscripción (cuota única)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={inscripcion}
            onChange={(e) => setInscripcion(e.target.value)}
            className="ek-input"
            placeholder="0"
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Se cobra <strong>una sola vez</strong>, al dar de alta al socio: ni al renovar ni al
            cambiar de plan se vuelve a cobrar. Si el socio ya pagó inscripción antes, tampoco.
            Dejalo en 0 si tu plan no cobra inscripción.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Pases de invitado por periodo</label>
          <input
            type="number"
            min={0}
            max={50}
            value={invitadosPorPeriodo}
            onChange={(e) => setInvitadosPorPeriodo(parseInt(e.target.value) || 0)}
            className="ek-input"
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Invitados que el socio puede traer <strong>en total</strong> durante cada periodo del
            plan (ej. 10 al mes; en un plan quincenal, 10 por quincena), no por clase. La bolsa se
            reinicia al renovar, y cancelar una reserva devuelve los pases. <strong>0</strong> = el
            plan no incluye invitados.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <Toggle
            checked={enVenta}
            onChange={setEnVenta}
            label="En venta"
            description="Encendido = el plan se muestra en la landing y se puede vender a socios nuevos. Apágalo para dejar de venderlo sin afectar a quienes ya lo tienen (ellos siguen reservando). Para eso, no lo archives."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Beneficios del plan</label>
          <BeneficiosEditor value={beneficios} onChange={setBeneficios} />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Lista de beneficios que se muestran al miembro en la landing y al hacer signup.
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
          className="tier-benefit-row"
          style={{
            display: 'grid',
            gap: '8px',
            alignItems: 'center',
            padding: '8px',
            background: 'var(--ek-bg-elevated)',
            borderRadius: 'var(--ek-r-sm)'
          }}
        >
          <span style={{ color: 'var(--ek-mustard)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <Check size={15} strokeWidth={2.5} />
          </span>

          <input
            type="text"
            value={beneficio}
            onChange={(e) => editar(idx, e.target.value)}
            className="ek-input"
            style={{ fontSize: '13px', padding: '6px 10px' }}
          />

          <div className="tier-benefit-controls" style={{ display: 'flex', gap: '4px' }}>
          <button
            type="button"
            onClick={() => mover(idx, 'up')}
            disabled={idx === 0}
            className="ek-icon-btn"
            style={{ padding: '4px 8px', opacity: idx === 0 ? 0.3 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            aria-label="Subir"
          >
            <ArrowUp size={15} strokeWidth={2.25} />
          </button>
          <button
            type="button"
            onClick={() => mover(idx, 'down')}
            disabled={idx === value.length - 1}
            className="ek-icon-btn"
            style={{
              padding: '4px 8px',
              opacity: idx === value.length - 1 ? 0.3 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            aria-label="Bajar"
          >
            <ArrowDown size={15} strokeWidth={2.25} />
          </button>
          <button
            type="button"
            onClick={() => eliminar(idx)}
            className="ek-icon-btn"
            style={{ padding: '4px 8px', color: 'var(--ek-danger)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            aria-label="Eliminar"
          >
            <X size={15} strokeWidth={2.25} />
          </button>
          </div>
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
          placeholder="Ej: Acceso a TODAS las salas"
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
