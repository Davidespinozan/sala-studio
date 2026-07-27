import { useEffect, useMemo, useState } from 'react';
import Papa from 'papaparse';
import { X } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { useToast } from '@shared/hooks/useToast';
import { useTenant } from '@shared/hooks/useTenant';

/* ══════════════════════════════════════════════════════════════════════════
   IMPORTAR MIEMBROS DESDE CSV — migración de otro sistema.
   ──────────────────────────────────────────────────────────────────────────
   Pasos: subir CSV → mapear columnas → mapear cada "plan" del archivo a un tier
   tuyo → preview con validación y duplicados → confirmar. El alta real (usuario
   sin auth + membresía con vencimiento, sin cobro) la hace la RPC importar_miembros.
   ══════════════════════════════════════════════════════════════════════════ */

type Tier = { id: string; nombre: string; slug: string; tipo: string };
type Paso = 'subir' | 'mapear' | 'preview' | 'listo';

// Campos destino. nombre/email obligatorios (el resto opcional).
const CAMPOS = [
  { key: 'nombre', label: 'Nombre', req: true },
  { key: 'email', label: 'Email', req: true },
  { key: 'telefono', label: 'Teléfono', req: false },
  { key: 'plan', label: 'Plan', req: false },
  { key: 'vencimiento', label: 'Vencimiento', req: false },
  { key: 'creditos', label: 'Clases restantes', req: false }
] as const;
type CampoKey = (typeof CAMPOS)[number]['key'];

// Adivina la columna del CSV para un campo, por nombre de encabezado.
const PISTAS: Record<CampoKey, string[]> = {
  nombre: ['nombre', 'name', 'nombre completo', 'cliente', 'socio', 'full name'],
  email: ['email', 'correo', 'e-mail', 'mail'],
  telefono: ['telefono', 'teléfono', 'phone', 'celular', 'movil', 'móvil', 'tel'],
  plan: ['plan', 'membresia', 'membresía', 'tier', 'paquete', 'plan actual'],
  vencimiento: ['vencimiento', 'vence', 'expira', 'expiration', 'fin', 'fecha fin', 'due'],
  creditos: ['creditos', 'créditos', 'clases', 'clases restantes', 'saldo', 'credits']
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Fecha a ISO (yyyy-mm-dd). Acepta ISO tal cual y d/m/aaaa (LatAm). Lo que no
 *  reconoce lo deja pasar; si la RPC no lo castea, esa fila sale como error. */
function normalizarFecha(v: string): string {
  const s = v.trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, d, mth, y] = m;
    return `${y}-${mth.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return s;
}

interface FilaFinal {
  nombre: string;
  email: string;
  telefono: string;
  tier_id: string;
  vencimiento: string;
  creditos: string;
  planTexto: string;
  problema: string | null;
}

export function ImportarMiembrosModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const tenant = useTenant();
  const [paso, setPaso] = useState<Paso>('subir');
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [columnas, setColumnas] = useState<string[]>([]);
  const [filasCsv, setFilasCsv] = useState<Record<string, string>[]>([]);
  const [mapa, setMapa] = useState<Record<CampoKey, string>>({ nombre: '', email: '', telefono: '', plan: '', vencimiento: '', creditos: '' });
  const [planTier, setPlanTier] = useState<Record<string, string>>({});
  const [tierDefault, setTierDefault] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resumen, setResumen] = useState<{ creados: number; omitidos: number; errores: number; detalle: any[] } | null>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('tiers')
        .select('id, nombre, slug, tipo')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('orden');
      setTiers((data as Tier[]) ?? []);
    })();
  }, [tenant.id]);

  function onArchivo(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const cols = (res.meta.fields ?? []).filter(Boolean);
        if (cols.length === 0) {
          toast.error('No pudimos leer columnas del archivo. ¿Es un CSV con encabezados?');
          return;
        }
        setColumnas(cols);
        setFilasCsv(res.data);
        // Auto-mapeo por pistas de encabezado.
        const auto = { ...mapa };
        for (const campo of CAMPOS) {
          const hit = cols.find((c) => PISTAS[campo.key].includes(c.toLowerCase().trim()));
          if (hit) auto[campo.key] = hit;
        }
        setMapa(auto);
        setPaso('mapear');
      },
      error: () => toast.error('No pudimos leer el archivo.')
    });
  }

  // Valores distintos de la columna "plan" (para mapear cada uno a un tier).
  const planesDistintos = useMemo(() => {
    if (!mapa.plan) return [];
    const set = new Set<string>();
    for (const f of filasCsv) {
      const v = (f[mapa.plan] ?? '').trim();
      if (v) set.add(v);
    }
    return [...set];
  }, [mapa.plan, filasCsv]);

  // Construye las filas finales con el tier resuelto y la validación.
  const filasFinales = useMemo<FilaFinal[]>(() => {
    const vistos = new Set<string>();
    return filasCsv.map((f) => {
      const nombre = (mapa.nombre ? f[mapa.nombre] : '')?.trim() ?? '';
      const email = (mapa.email ? f[mapa.email] : '')?.trim().toLowerCase() ?? '';
      const telefono = (mapa.telefono ? f[mapa.telefono] : '')?.trim() ?? '';
      const planTexto = (mapa.plan ? f[mapa.plan] : '')?.trim() ?? '';
      const tier_id = mapa.plan ? (planTier[planTexto] ?? '') : tierDefault;
      const vencimiento = normalizarFecha((mapa.vencimiento ? f[mapa.vencimiento] : '') ?? '');
      const creditos = (mapa.creditos ? f[mapa.creditos] : '')?.replace(/[^\d]/g, '') ?? '';

      let problema: string | null = null;
      if (!nombre) problema = 'Sin nombre';
      else if (!email) problema = 'Sin email';
      else if (!EMAIL_RE.test(email)) problema = 'Email inválido';
      else if (!tier_id) problema = 'Plan sin asignar';
      else if (vistos.has(email)) problema = 'Email repetido en el archivo';
      if (email && !problema) vistos.add(email);

      return { nombre, email, telefono, tier_id, vencimiento, creditos, planTexto, problema };
    });
  }, [filasCsv, mapa, planTier, tierDefault]);

  const listos = filasFinales.filter((f) => !f.problema);
  const conProblema = filasFinales.filter((f) => f.problema);
  const mapeoOk = !!mapa.nombre && !!mapa.email && (mapa.plan ? planesDistintos.every((p) => planTier[p]) : !!tierDefault);

  async function importar() {
    if (listos.length === 0) return;
    setEnviando(true);
    try {
      // Trocear por si el padrón es enorme (la función topa en 2000/lote).
      const lotes: FilaFinal[][] = [];
      for (let i = 0; i < listos.length; i += 1500) lotes.push(listos.slice(i, i + 1500));
      const acc = { creados: 0, omitidos: 0, errores: 0, detalle: [] as any[] };
      for (const lote of lotes) {
        const r = await backendPost<{ creados: number; omitidos: number; errores: number; detalle: any[] }>('importar-miembros', {
          rows: lote.map((f) => ({ nombre: f.nombre, email: f.email, telefono: f.telefono, tier_id: f.tier_id, vencimiento: f.vencimiento, creditos: f.creditos }))
        });
        acc.creados += r.creados; acc.omitidos += r.omitidos; acc.errores += r.errores;
        acc.detalle.push(...(r.detalle ?? []));
      }
      setResumen(acc);
      setPaso('listo');
      if (acc.creados > 0) onImported();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos completar la importación.');
    } finally {
      setEnviando(false);
    }
  }

  function descargarNoImportados() {
    const filas = (resumen?.detalle ?? []).filter((d) => d.resultado !== 'creado');
    const csv = 'email,nombre,resultado,motivo\n' +
      filas.map((d) => [d.email ?? '', d.nombre ?? '', d.resultado, d.motivo ?? ''].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'no-importados.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="ek-modal-backdrop" role="dialog" aria-modal="true" aria-label="Importar miembros" onClick={onClose}>
      <div className="ek-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <div>
            <p className="ek-eyebrow">IMPORTAR</p>
            <h2 className="ek-h3" style={{ margin: 0 }}>Migrar miembros de otro sistema</h2>
          </div>
          <button className="ek-icon-btn" aria-label="Cerrar" onClick={onClose}><X size={18} /></button>
        </div>

        {/* ── Paso 1: subir ──────────────────────────────────────────────── */}
        {paso === 'subir' && (
          <div>
            <p className="ek-body-muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
              Sube un CSV con tus socios: nombre y email son obligatorios; teléfono, plan,
              vencimiento y clases restantes son opcionales. No se les cobra nada — quedan activos con
              su vencimiento actual.
            </p>
            <label className="ek-cta ek-cta--secondary" style={{ display: 'inline-flex', cursor: 'pointer' }}>
              Elegir archivo CSV
              <input type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onArchivo(f); }} />
            </label>
          </div>
        )}

        {/* ── Paso 2: mapear columnas + planes ───────────────────────────── */}
        {paso === 'mapear' && (
          <div>
            <p className="ek-body-muted" style={{ fontSize: 13, marginBottom: 12 }}>
              {filasCsv.length} filas leídas. Dinos qué columna es cada dato:
            </p>
            <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
              {CAMPOS.map((c) => (
                <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 130, fontSize: 13, fontWeight: 600 }}>
                    {c.label}{c.req && <span style={{ color: 'var(--ek-danger)' }}> *</span>}
                  </span>
                  <select className="ek-input" style={{ flex: 1 }} value={mapa[c.key]}
                    onChange={(e) => setMapa((m) => ({ ...m, [c.key]: e.target.value }))}>
                    <option value="">— ninguna —</option>
                    {columnas.map((col) => <option key={col} value={col}>{col}</option>)}
                  </select>
                </div>
              ))}
            </div>

            {/* Mapeo de planes → tiers. Si no hay columna de plan, un tier por defecto. */}
            <div style={{ borderTop: '1px solid var(--ek-line)', paddingTop: 14, marginBottom: 16 }}>
              {mapa.plan ? (
                planesDistintos.length === 0 ? (
                  <p className="ek-body-muted" style={{ fontSize: 12.5 }}>Esa columna no tiene valores de plan.</p>
                ) : (
                  <>
                    <div className="ek-body-muted" style={{ fontSize: 12.5, marginBottom: 8 }}>A qué plan tuyo corresponde cada uno:</div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {planesDistintos.map((p) => (
                        <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ width: 130, fontSize: 13, wordBreak: 'break-word' }}>{p}</span>
                          <select className="ek-input" style={{ flex: 1 }} value={planTier[p] ?? ''}
                            onChange={(e) => setPlanTier((m) => ({ ...m, [p]: e.target.value }))}>
                            <option value="">— elige un plan —</option>
                            {tiers.map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  </>
                )
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 130, fontSize: 13, fontWeight: 600 }}>Plan para todos</span>
                  <select className="ek-input" style={{ flex: 1 }} value={tierDefault} onChange={(e) => setTierDefault(e.target.value)}>
                    <option value="">— elige un plan —</option>
                    {tiers.map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="ek-cta ek-cta--secondary" onClick={() => setPaso('subir')}>Atrás</button>
              <button className="ek-cta" disabled={!mapeoOk} onClick={() => setPaso('preview')}>Ver preview</button>
            </div>
          </div>
        )}

        {/* ── Paso 3: preview ────────────────────────────────────────────── */}
        {paso === 'preview' && (
          <div>
            <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
              <span style={{ fontSize: 14 }}><b style={{ color: 'var(--ek-ok, #34d399)' }}>{listos.length}</b> listos</span>
              <span style={{ fontSize: 14 }}><b style={{ color: conProblema.length ? 'var(--ek-danger)' : 'var(--ek-ink-faint)' }}>{conProblema.length}</b> con problema (se omiten)</span>
            </div>
            <div className="ek-card" style={{ padding: 0, maxHeight: 260, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr>{['Nombre', 'Email', 'Plan', 'Vence', 'Estado'].map((h) => <th key={h} style={thc}>{h}</th>)}</tr></thead>
                <tbody>
                  {filasFinales.slice(0, 200).map((f, i) => (
                    <tr key={i} style={{ background: f.problema ? 'var(--ek-danger-dim, rgba(239,68,68,.06))' : undefined }}>
                      <td style={tdc}>{f.nombre || '—'}</td>
                      <td style={tdc}>{f.email || '—'}</td>
                      <td style={tdc}>{f.planTexto || (tierDefault ? tiers.find((t) => t.id === tierDefault)?.nombre : '—')}</td>
                      <td style={tdc}>{f.vencimiento || '—'}</td>
                      <td style={{ ...tdc, color: f.problema ? 'var(--ek-danger)' : 'var(--ek-ink-faint)' }}>{f.problema ?? 'OK'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filasFinales.length > 200 && <p className="ek-body-muted" style={{ fontSize: 11.5, marginTop: 6 }}>Mostrando las primeras 200 de {filasFinales.length}.</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="ek-cta ek-cta--secondary" onClick={() => setPaso('mapear')}>Atrás</button>
              <button className="ek-cta" disabled={listos.length === 0 || enviando} onClick={importar}>
                {enviando ? 'Importando…' : `Importar ${listos.length} miembros`}
              </button>
            </div>
          </div>
        )}

        {/* ── Paso 4: resultado ──────────────────────────────────────────── */}
        {paso === 'listo' && resumen && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 16 }}>
              <Kpi n={resumen.creados} label="Creados" color="var(--ek-ok, #34d399)" />
              <Kpi n={resumen.omitidos} label="Omitidos" color="var(--ek-ink-faint)" />
              <Kpi n={resumen.errores} label="Con error" color={resumen.errores ? 'var(--ek-danger)' : 'var(--ek-ink-faint)'} />
            </div>
            <p className="ek-body-muted" style={{ fontSize: 13, marginBottom: 16 }}>
              Los miembros quedaron activos con su vencimiento. Para que entren a la app, después
              activaremos que reclamen su cuenta.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {(resumen.omitidos + resumen.errores) > 0 && (
                <button className="ek-cta ek-cta--secondary" onClick={descargarNoImportados}>Descargar no importados</button>
              )}
              <button className="ek-cta" onClick={onClose}>Listo</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div className="ek-card" style={{ padding: '12px 14px', textAlign: 'center' }}>
      <div style={{ fontSize: 26, fontWeight: 800, color }}>{n}</div>
      <div style={{ fontSize: 11, color: 'var(--ek-ink-faint)', textTransform: 'uppercase', letterSpacing: '.1em' }}>{label}</div>
    </div>
  );
}

const thc: React.CSSProperties = { textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)', padding: '8px 10px', borderBottom: '1px solid var(--ek-line)', position: 'sticky', top: 0, background: 'var(--ek-bg)' };
const tdc: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--ek-line)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 };
