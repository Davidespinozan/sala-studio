import { useTenant } from '@shared/hooks/useTenant';

/** Estilo del hero CON imagen: 'contenido' = card con esquinas redondeadas
 *  (flota sobre el fondo); 'completo' = full-bleed de borde a borde. */
export type LandingHeroLayout = 'contenido' | 'completo';

export type LandingHero = {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  subtitulo: string;
  cta_texto: string;
  cta_link: string;
  /** Imagen de fondo del hero para DESKTOP (16:9). Vacío = hero de texto. */
  image_url: string;
  /** Imagen de fondo del hero para MÓVIL (3:4 vertical). Cae a la desktop si falta. */
  image_url_mobile: string;
  /** Estilo del hero con imagen. Default 'contenido'. */
  layout: LandingHeroLayout;
};

type LandingCtaFinal = {
  eyebrow: string;
  titulo: string;
  subtitulo: string;
  cta_texto: string;
};

type LandingFooterRedes = {
  instagram: string | null;
  tiktok: string | null;
  youtube: string | null;
  facebook: string | null;
};

type LandingFooter = {
  tagline: string;
  copyright: string;
  direccion: string | null;
  email: string | null;
  redes: LandingFooterRedes;
};

type ContactoConfig = {
  whatsapp_e164: string;
  whatsapp_mensaje_default: string;
};

// Defaults: strings vacíos por diseño (kernel reusable).
// Los textos reales de un tenant vienen de la migración SQL del tenant inicial.
// Un tenant nuevo sin config no rompe — solo se ve "neutro" hasta que admin
// llene los campos.
const HERO_DEFAULT: LandingHero = {
  eyebrow: '',
  titulo: '',
  titulo_accent: '',
  subtitulo: '',
  cta_texto: 'Ver membresías',
  cta_link: '#membresias',
  image_url: '',
  image_url_mobile: '',
  layout: 'contenido'
};

const CTA_FINAL_DEFAULT: LandingCtaFinal = {
  eyebrow: '',
  titulo: '',
  subtitulo: '',
  cta_texto: 'Contáctanos'
};

const REDES_DEFAULT: LandingFooterRedes = {
  instagram: null,
  tiktok: null,
  youtube: null,
  facebook: null
};

const FOOTER_DEFAULT: LandingFooter = {
  tagline: '',
  copyright: 'Todos los derechos reservados.',
  direccion: null,
  email: null,
  redes: REDES_DEFAULT
};

const CONTACTO_DEFAULT: ContactoConfig = {
  whatsapp_e164: '',
  whatsapp_mensaje_default: 'Hola, me interesa saber más.'
};

function parseObject<T extends object>(value: unknown, fallback: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  return { ...fallback, ...(value as Partial<T>) };
}

// ── Sección post-hero: 3 variantes visuales + ocultar, contenido editable ──
export type PostHeroVariante = 'pasos' | 'beneficios' | 'destacados' | 'ninguna';
export type PostHeroItem = { titulo: string; texto: string };
export type LandingPostHero = {
  variante: PostHeroVariante;
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  items: PostHeroItem[];
};

const POST_HERO_DEFAULT: LandingPostHero = {
  variante: 'pasos',
  eyebrow: 'CÓMO FUNCIONA',
  titulo: 'De cero a tu primera clase.',
  titulo_accent: 'En tres pasos.',
  items: [
    { titulo: 'Elegí tu plan', texto: 'Pickeá la membresía que va con tu ritmo. Sin permanencia rara, sin letra chica.' },
    { titulo: 'Reservá desde la app', texto: 'Elegí sala, día y horario en segundos. Sin llamadas, sin esperar.' },
    { titulo: 'Llegá y entrená', texto: 'Mostrá tu QR en recepción y listo. Las salas ya están montadas con todo el equipo.' }
  ]
};

const POST_HERO_VARIANTES: PostHeroVariante[] = ['pasos', 'beneficios', 'destacados', 'ninguna'];

function parsePostHero(value: unknown): LandingPostHero {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return POST_HERO_DEFAULT;
  const v = value as Record<string, unknown>;
  const variante = POST_HERO_VARIANTES.includes(v.variante as PostHeroVariante)
    ? (v.variante as PostHeroVariante)
    : POST_HERO_DEFAULT.variante;
  const items = Array.isArray(v.items)
    ? (v.items as unknown[]).slice(0, 4).map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        return { titulo: String(o.titulo ?? ''), texto: String(o.texto ?? '') };
      })
    : POST_HERO_DEFAULT.items;
  return {
    variante,
    eyebrow: String(v.eyebrow ?? POST_HERO_DEFAULT.eyebrow),
    titulo: String(v.titulo ?? POST_HERO_DEFAULT.titulo),
    titulo_accent: String(v.titulo_accent ?? POST_HERO_DEFAULT.titulo_accent),
    items: items.length ? items : POST_HERO_DEFAULT.items
  };
}

// ── FAQ de la landing: editable por el admin. Default GENÉRICO (sin reglas de
//    negocio específicas que serían falsas para muchos gyms). ──
export type LandingFaqItem = { pregunta: string; respuesta: string };

const FAQ_DEFAULT: LandingFaqItem[] = [
  { pregunta: '¿Qué incluye la membresía?', respuesta: 'Acceso a las salas y clases según tu plan, con reservas desde la app. Mirá el detalle de cada plan más arriba.' },
  { pregunta: '¿Cómo reservo una clase?', respuesta: 'Desde la app: elegís sala, día y horario en segundos, y mostrás tu QR al llegar.' },
  { pregunta: '¿Puedo cancelar una reserva?', respuesta: 'Sí. Cancelá con anticipación para liberar tu lugar; las reglas de cancelación las define tu plan.' },
  { pregunta: '¿Puedo invitar gente?', respuesta: 'Según tu plan, podés llevar invitados. Mirá los planes para el detalle.' }
];

/** missing/null → default genérico. Array explícito (aunque vacío) → lo del admin
 *  (vacío = ocultar la sección). */
function parseFaq(value: unknown): LandingFaqItem[] {
  if (value === undefined || value === null || !Array.isArray(value)) return FAQ_DEFAULT;
  return (value as unknown[])
    .slice(0, 12)
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>;
      return { pregunta: String(o.pregunta ?? ''), respuesta: String(o.respuesta ?? '') };
    })
    .filter((f) => f.pregunta.trim() || f.respuesta.trim());
}

export function useLandingConfig() {
  const tenant = useTenant();
  const config = (tenant.config ?? {}) as Record<string, unknown>;
  const landing = (config.landing ?? {}) as Record<string, unknown>;
  const contactoRaw = (config.contacto ?? {}) as Record<string, unknown>;

  const hero = parseObject(landing.hero, HERO_DEFAULT);
  const post_hero = parsePostHero(landing.post_hero);
  const cta_final = parseObject(landing.cta_final, CTA_FINAL_DEFAULT);
  const faq = parseFaq(landing.faq);

  const footerBase = parseObject(landing.footer, FOOTER_DEFAULT);
  // redes es objeto anidado: re-merge para garantizar todas las keys
  const footer: LandingFooter = {
    ...footerBase,
    redes: parseObject(
      (landing.footer as { redes?: unknown } | undefined)?.redes,
      REDES_DEFAULT
    )
  };

  const contacto = parseObject(contactoRaw, CONTACTO_DEFAULT);

  // S6-5: toggle de la sección de instructores en la landing. Default false.
  const mostrarInstructores = landing.mostrar_instructores === true;

  // Helper: URL completa de WhatsApp con mensaje encoded.
  // Devuelve null si no hay número configurado → render condicional en el consumidor.
  const whatsappUrl = (mensaje?: string): string | null => {
    if (!contacto.whatsapp_e164) return null;
    const msg = encodeURIComponent(mensaje ?? contacto.whatsapp_mensaje_default);
    return `https://wa.me/${contacto.whatsapp_e164}?text=${msg}`;
  };

  return {
    hero,
    post_hero,
    cta_final,
    footer,
    faq,
    contacto,
    mostrarInstructores,
    whatsappUrl
  };
}
