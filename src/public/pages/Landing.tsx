import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { useLandingConfig } from '@shared/hooks/useLandingConfig';
import EstudioModal, { type EstudioInfo } from '../components/EstudioModal';
import Footer from '../components/Footer';

interface EstudioPublico {
  id: string;
  slug: string;
  nombre: string;
  descripcion: string | null;
  tiers_permitidos: string[];
  tipo_contenido: string[] | null;
  equipo_incluido: string[] | null;
  estilo_visual: string | null;
  capacidad_personas: number | null;
  foto_url: string | null;
}

interface TierPublico {
  slug: string;
  nombre: string;
  precio_centavos: number;
  descripcion: string | null;
  beneficios: unknown;
  reglas: Record<string, unknown> | null;
  orden: number;
}

function useEstudiosPublicos() {
  const [estudios, setEstudios] = useState<EstudioPublico[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('recursos')
        .select(
          'id, slug, nombre, descripcion, tiers_permitidos, tipo_contenido, equipo_incluido, estilo_visual, capacidad_personas, foto_url'
        )
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (!mounted) return;
      if (error) console.error('[useEstudiosPublicos]', error);
      else setEstudios((data ?? []) as EstudioPublico[]);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, []);

  return { estudios, isLoading };
}

function useTiersPublicos() {
  const [tiers, setTiers] = useState<TierPublico[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos, descripcion, beneficios, reglas, orden')
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (!mounted) return;
      if (error) console.error('[useTiersPublicos]', error);
      else setTiers((data ?? []) as TierPublico[]);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, []);

  return { tiers, isLoading };
}

function parseBeneficios(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((b): b is string => typeof b === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((b): b is string => typeof b === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function formatearPesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

export default function Landing() {
  const [estudioAbierto, setEstudioAbierto] = useState<EstudioInfo | null>(null);
  const { estudios, isLoading: estudiosLoading } = useEstudiosPublicos();
  const { tiers, isLoading: tiersLoading } = useTiersPublicos();
  const { hero, cta_final, whatsappUrl } = useLandingConfig();
  const ctaWhatsappUrl = whatsappUrl();

  const precioPro = tiers.find((t) => t.slug === 'pro')?.precio_centavos;
  const precioBasica = tiers.find((t) => t.slug === 'basica')?.precio_centavos;

  const aEstudioInfo = (r: EstudioPublico): EstudioInfo => {
    const esPro = r.tiers_permitidos.length === 1 && r.tiers_permitidos[0] === 'pro';
    const tier: 'basica' | 'pro' = esPro ? 'pro' : 'basica';
    return {
      slug: r.slug,
      nombre: r.nombre,
      tier,
      capacidad: r.capacidad_personas
        ? `Hasta ${r.capacidad_personas} personas`
        : 'Capacidad por confirmar',
      contenido: r.tipo_contenido ?? [],
      descripcion: r.descripcion ?? '',
      estiloVisual: r.estilo_visual ?? '',
      equipoIncluido: r.equipo_incluido ?? [],
      fotoUrl: r.foto_url ?? undefined,
      precioPro: precioPro ? Math.round(precioPro / 100) : undefined,
      precioBasica: precioBasica ? Math.round(precioBasica / 100) : undefined
    };
  };

  const estudiosInfo = estudios.map(aEstudioInfo);

  return (
    <div style={{
      maxWidth: '1200px',
      margin: '0 auto',
      padding: '0 24px'
    }}>
      {/* ============================================================
          HERO
          ============================================================ */}
      <section style={{
        minHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        position: 'relative',
        padding: '40px 0'
      }}>
        <div style={{
          position: 'absolute',
          top: '20%',
          right: '-200px',
          width: '500px',
          height: '500px',
          background: 'radial-gradient(circle, rgba(229, 184, 41, 0.12), transparent 70%)',
          borderRadius: '50%',
          pointerEvents: 'none'
        }} />

        {hero.eyebrow && (
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '20px' }}>
            {hero.eyebrow}
          </p>
        )}

        <h1 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(48px, 10vw, 96px)',
          fontWeight: 700,
          letterSpacing: '-0.05em',
          lineHeight: 0.95,
          margin: 0,
          marginBottom: '24px'
        }}>
          {hero.titulo}
          {hero.titulo_accent && (
            <>
              {hero.titulo && <br />}
              <span style={{ color: 'var(--ek-mustard)' }}>{hero.titulo_accent}</span>
            </>
          )}
        </h1>

        {hero.subtitulo && (
          <p style={{
            fontSize: 'clamp(16px, 2vw, 20px)',
            color: 'var(--ek-ink-muted)',
            maxWidth: '600px',
            lineHeight: 1.5,
            marginBottom: '40px'
          }}>
            {hero.subtitulo}
          </p>
        )}

        <a
          href={hero.cta_link || '#membresias'}
          className="ek-cta"
          style={{ padding: '16px 28px', fontSize: '15px', display: 'inline-block' }}
        >
          {hero.cta_texto}
        </a>
      </section>

      {/* ============================================================
          CÓMO FUNCIONA
          ============================================================ */}
      <section style={{ padding: '80px 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>CÓMO FUNCIONA</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '48px'
        }}>
          De la idea al contenido.<br />
          <span style={{ color: 'var(--ek-mustard)' }}>En tres pasos.</span>
        </h2>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '20px'
        }}>
          {[
            {
              n: '01',
              title: 'Reserva tu sesión',
              body: 'Elige estudio, fecha y horario desde la app. Sin llamadas, sin esperas. 24 horas de anticipación mínima.'
            },
            {
              n: '02',
              title: 'Llega y graba',
              body: 'Equipo profesional ya montado. Cámaras, micrófonos, iluminación. Tú llegas con tu contenido en la cabeza.'
            },
            {
              n: '03',
              title: 'Recibe tu material',
              body: 'Te entregamos los archivos limpios después de cada sesión. Tú decides cómo editarlo y publicarlo.'
            }
          ].map((paso) => (
            <div key={paso.n} className="ek-card">
              <p style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '32px',
                fontWeight: 700,
                color: 'var(--ek-mustard)',
                margin: 0,
                marginBottom: '12px',
                letterSpacing: '-0.04em'
              }}>{paso.n}</p>
              <h3 style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '20px',
                fontWeight: 600,
                margin: 0,
                marginBottom: '8px'
              }}>{paso.title}</h3>
              <p style={{
                fontSize: '14px',
                color: 'var(--ek-ink-muted)',
                lineHeight: 1.5,
                margin: 0
              }}>{paso.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ============================================================
          ESTUDIOS
          ============================================================ */}
      <section style={{ padding: '80px 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>NUESTROS ESPACIOS</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '16px'
        }}>
          Tres estudios.<br />
          <span style={{ color: 'var(--ek-mustard)' }}>Tres personalidades.</span>
        </h2>
        <p className="ek-body-muted" style={{ marginBottom: '40px', maxWidth: '600px' }}>
          Cada uno diseñado para un tipo de contenido. Elige el que va con tu visión.
        </p>

        {estudiosLoading ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '20px'
          }}>
            {[1, 2, 3].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '380px', borderRadius: 'var(--ek-r-card)' }} />
            ))}
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '20px'
          }}>
            {estudiosInfo.map((s) => (
              <button
                key={s.slug}
                onClick={() => setEstudioAbierto(s)}
                className="ek-card"
                style={{
                  padding: 0,
                  overflow: 'hidden',
                  cursor: 'pointer',
                  textAlign: 'left',
                  border: '0.5px solid var(--ek-line)',
                  background: 'var(--ek-bg-soft)',
                  color: 'var(--ek-ink)',
                  transition: 'transform 0.2s ease, border-color 0.2s ease',
                  font: 'inherit'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.borderColor = 'var(--ek-mustard-dim)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.borderColor = 'var(--ek-line)';
                }}
              >
                <div style={{
                  background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
                  aspectRatio: '16 / 10',
                  position: 'relative',
                  overflow: 'hidden'
                }}>
                  {s.fotoUrl ? (
                    <img
                      src={s.fotoUrl}
                      alt={s.nombre}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <div style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      <span style={{
                        fontSize: '10px',
                        color: 'var(--ek-ink-faint)',
                        letterSpacing: '0.2em',
                        fontWeight: 600
                      }}>FOTO PRÓXIMAMENTE</span>
                    </div>
                  )}
                  <span
                    className={s.tier === 'pro' ? 'ek-badge ek-badge--outline' : 'ek-badge'}
                    style={{ position: 'absolute', top: '14px', left: '14px' }}
                  >
                    {s.tier === 'pro' ? '★ PRO' : 'BÁSICA'}
                  </span>
                </div>
                <div style={{ padding: '20px' }}>
                  <h3 style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: '24px',
                    fontWeight: 700,
                    margin: 0,
                    marginBottom: '6px'
                  }}>{s.nombre}</h3>
                  <p style={{
                    fontSize: '13px',
                    color: 'var(--ek-ink-muted)',
                    margin: 0,
                    marginBottom: '6px'
                  }}>{s.capacidad}</p>
                  <p style={{
                    fontSize: '12px',
                    color: 'var(--ek-mustard)',
                    margin: 0,
                    marginBottom: '12px',
                    fontWeight: 600
                  }}>{s.contenido.join(' · ')}</p>
                  <p style={{
                    fontSize: '11px',
                    color: 'var(--ek-ink-faint)',
                    margin: 0,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    fontWeight: 600
                  }}>
                    Ver detalle →
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ============================================================
          MEMBRESÍAS
          ============================================================ */}
      <section id="membresias" style={{ padding: '80px 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>MEMBRESÍAS</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '48px'
        }}>
          Elige tu nivel.<br />
          <span style={{ color: 'var(--ek-mustard)' }}>Crece desde el día uno.</span>
        </h2>

        {tiersLoading ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '20px'
          }}>
            {[1, 2].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '480px', borderRadius: 'var(--ek-r-card)' }} />
            ))}
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '20px'
          }}>
            {tiers.map((tier) => {
              const esPro = tier.slug === 'pro';
              const beneficios = parseBeneficios(tier.beneficios);

              return (
                <div
                  key={tier.slug}
                  className="ek-card"
                  style={{
                    padding: '32px',
                    ...(esPro && {
                      borderColor: 'var(--ek-mustard)',
                      boxShadow:
                        '0 0 0 1px var(--ek-mustard-dim), 0 20px 60px rgba(229, 184, 41, 0.08)'
                    })
                  }}
                >
                  <p
                    className={esPro ? 'ek-eyebrow ek-eyebrow--mustard' : 'ek-eyebrow'}
                    style={{ marginBottom: '12px' }}
                  >
                    {esPro ? '★ PRO · RECOMENDADA' : tier.nombre.toUpperCase()}
                  </p>
                  <p style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: '48px',
                    fontWeight: 700,
                    margin: 0,
                    letterSpacing: '-0.03em',
                    lineHeight: 1
                  }}>
                    {formatearPesos(tier.precio_centavos)}
                    <span style={{ fontSize: '16px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>
                      /mes
                    </span>
                  </p>
                  <p className="ek-body-muted" style={{ marginTop: '8px', marginBottom: '24px' }}>
                    {tier.descripcion ??
                      (esPro
                        ? 'Para creadores serios. Acceso completo.'
                        : 'Para empezar. Acceso a los estudios básicos.')}
                  </p>
                  <ul
                    style={{
                      listStyle: 'none',
                      padding: 0,
                      margin: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px'
                    }}
                  >
                    {beneficios.map((b) => (
                      <li
                        key={b}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '8px',
                          fontSize: '14px'
                        }}
                      >
                        <span style={{ color: 'var(--ek-mustard)' }}>✓</span>
                        {b}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={`/signup?tier=${tier.slug}`}
                    className={
                      esPro ? 'ek-cta ek-cta--full' : 'ek-cta ek-cta--secondary ek-cta--full'
                    }
                    style={{ marginTop: '28px' }}
                  >
                    {esPro ? 'Quiero la Pro' : `Empezar con ${tier.nombre}`}
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ============================================================
          FAQ
          ============================================================ */}
      <section style={{ padding: '80px 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>PREGUNTAS FRECUENTES</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '48px'
        }}>
          Lo que probablemente quieres saber.
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {[
            {
              q: '¿Qué incluye la membresía?',
              a: 'Acceso a los estudios según tu plan, todo el equipo profesional ya montado (cámaras, micrófonos, iluminación), espacio para invitados y reservas vía app.'
            },
            {
              q: '¿Puedo cancelar cuándo quiera?',
              a: 'El compromiso mínimo es de 6 meses. Después puedes cancelar con 30 días de anticipación. Sin penalidades por cancelación pasado el commitment.'
            },
            {
              q: '¿Qué pasa si no llego a mi reserva?',
              a: 'Las inasistencias bloquean tu cuenta por 1 semana automáticamente. Pero si avisas con anticipación, puedes cancelar sin penalidad.'
            },
            {
              q: '¿Necesito traer mi propio equipo?',
              a: 'No. Cada estudio tiene su equipo profesional completo. Solo traes tu contenido y tu disco duro para llevarte el material.'
            },
            {
              q: '¿Puedo invitar gente?',
              a: 'Sí. Básica permite hasta 2 invitados por sesión, Pro hasta 4. Para producciones más grandes en Black, contáctanos.'
            },
            {
              q: '¿Cómo me cobran?',
              a: 'Cobro mensual automatizado vía tarjeta. El primer mes incluye onboarding y configuración de tu cuenta.'
            }
          ].map((item) => (
            <details key={item.q} className="ek-card" style={{ padding: '20px 24px', cursor: 'pointer' }}>
              <summary style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '17px',
                fontWeight: 600,
                letterSpacing: '-0.01em',
                listStyle: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                {item.q}
                <span style={{ color: 'var(--ek-mustard)', fontSize: '14px' }}>+</span>
              </summary>
              <p style={{
                fontSize: '14px',
                color: 'var(--ek-ink-muted)',
                lineHeight: 1.6,
                margin: 0,
                marginTop: '12px'
              }}>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ============================================================
          CTA + CONTACTO
          ============================================================ */}
      <section id="contacto" style={{ padding: '100px 0' }}>
        <div style={{
          background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
          border: '0.5px solid var(--ek-mustard-dim)',
          borderRadius: 'var(--ek-r-card)',
          padding: 'clamp(32px, 6vw, 64px)',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden'
        }}>
          <div style={{
            position: 'absolute',
            top: '-100px',
            right: '-100px',
            width: '300px',
            height: '300px',
            background: 'radial-gradient(circle, rgba(229, 184, 41, 0.1), transparent 70%)',
            borderRadius: '50%',
            pointerEvents: 'none'
          }} />

          {cta_final.eyebrow && (
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '16px' }}>
              {cta_final.eyebrow}
            </p>
          )}
          <h2 style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(32px, 5vw, 48px)',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            margin: 0,
            marginBottom: '16px',
            lineHeight: 1.1
          }}>
            {cta_final.titulo}
          </h2>
          {cta_final.subtitulo && (
            <p className="ek-body-muted" style={{ marginBottom: '32px', maxWidth: '500px', marginLeft: 'auto', marginRight: 'auto' }}>
              {cta_final.subtitulo}
            </p>
          )}
          {ctaWhatsappUrl ? (
            <a
              href={ctaWhatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ek-cta"
              style={{ padding: '18px 32px', fontSize: '15px' }}
            >
              {cta_final.cta_texto}
            </a>
          ) : (
            <span
              style={{
                fontSize: '12px',
                color: 'var(--ek-ink-faint)',
                fontStyle: 'italic'
              }}
              title="Configura el WhatsApp en /admin/configuracion"
            >
              (Contacto sin configurar)
            </span>
          )}
        </div>
      </section>

      {/* ============================================================
          FOOTER (extraído a src/public/components/Footer.tsx)
          ============================================================ */}
      <Footer />

      <EstudioModal
        estudio={estudioAbierto}
        onClose={() => setEstudioAbierto(null)}
      />
    </div>
  );
}
