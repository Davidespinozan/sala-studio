import { useTenant } from '@shared/hooks/useTenant';

/** Estilo del hero CON imagen: 'contenido' = card con esquinas redondeadas
 *  (flota sobre el fondo); 'completo' = full-bleed de borde a borde. */
export type LandingHeroLayout = 'contenido' | 'completo';

/** Un slide del carrusel del hero: imagen desktop (16:9) + móvil (3:4). */
export type LandingHeroSlide = { desktop: string; mobile: string };

export type LandingHero = {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  subtitulo: string;
  cta_texto: string;
  /** Link del botón del hero. Opcional: si falta, cae a '#membresias' (el botón
   *  siempre lleva a la sección de membresías; ya no se edita desde el admin). */
  cta_link?: string;
  /** 2º CTA (estilo outline). Vacío → no se muestra. */
  cta2_texto?: string;
  cta2_link?: string;
  /** Imagen de fondo del hero para DESKTOP (16:9). Vacío = hero de texto. */
  image_url: string;
  /** Imagen de fondo del hero para MÓVIL (3:4 vertical). Cae a la desktop si falta. */
  image_url_mobile: string;
  /** Carrusel del hero: varios slides (desktop + móvil) que rotan. Vacío → cae a
   *  image_url (una sola). Editable desde el admin. */
  imagenes: LandingHeroSlide[];
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
  cta2_texto: '',
  cta2_link: '#membresias',
  image_url: '',
  image_url_mobile: '',
  imagenes: [],
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

// ── Encabezados editables de cada sección de la landing (eyebrow + título +
//    acento + bajada). Antes estaban hardcodeados en Landing.tsx. ──
export type LandingSeccionHeading = {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  subtitulo: string;
};

export type LandingSecciones = {
  salas: LandingSeccionHeading;
  membresias: LandingSeccionHeading;
  instructores: LandingSeccionHeading;
  faq: LandingSeccionHeading;
};

/** Defaults = copy original (verbatim) para no cambiar nada hasta que el gym
 *  edite. Exportados para que el editor arranque con estos valores. */
export const SECCIONES_DEFAULT: LandingSecciones = {
  salas: {
    eyebrow: 'NUESTRAS SALAS',
    titulo: 'Varias disciplinas.',
    titulo_accent: 'Un solo lugar.',
    subtitulo: 'Cada sala diseñada para una disciplina distinta. Elegí la que va con vos.'
  },
  membresias: {
    eyebrow: 'MEMBRESÍAS',
    titulo: 'Elige tu nivel.',
    titulo_accent: 'Crece desde el día uno.',
    subtitulo: ''
  },
  instructores: {
    eyebrow: 'NUESTRO EQUIPO',
    titulo: 'Conocé a nuestros',
    titulo_accent: 'instructores.',
    subtitulo: 'El equipo que te va a acompañar en cada clase.'
  },
  faq: {
    eyebrow: 'PREGUNTAS FRECUENTES',
    titulo: 'Lo que probablemente querés saber.',
    titulo_accent: '',
    subtitulo: ''
  }
};

/** Un heading nunca guardado → default. Guardado (aunque con campos vacíos) →
 *  se respeta (vacío = ocultar ese campo). */
function parseSeccionHeading(value: unknown, def: LandingSeccionHeading): LandingSeccionHeading {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return def;
  const o = value as Record<string, unknown>;
  return {
    eyebrow: String(o.eyebrow ?? ''),
    titulo: String(o.titulo ?? ''),
    titulo_accent: String(o.titulo_accent ?? ''),
    subtitulo: String(o.subtitulo ?? '')
  };
}

function parseSecciones(value: unknown): LandingSecciones {
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    salas: parseSeccionHeading(o.salas, SECCIONES_DEFAULT.salas),
    membresias: parseSeccionHeading(o.membresias, SECCIONES_DEFAULT.membresias),
    instructores: parseSeccionHeading(o.instructores, SECCIONES_DEFAULT.instructores),
    faq: parseSeccionHeading(o.faq, SECCIONES_DEFAULT.faq)
  };
}

/** Slides del carrusel del hero. Compat: si vienen strings viejos (solo URL),
 *  se interpretan como {desktop, mobile:''}. Filtra los sin desktop. */
function parseHeroSlides(value: unknown): LandingHeroSlide[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .map((it): LandingHeroSlide => {
      if (typeof it === 'string') return { desktop: it.trim(), mobile: '' };
      if (it && typeof it === 'object') {
        const o = it as Record<string, unknown>;
        return { desktop: String(o.desktop ?? '').trim(), mobile: String(o.mobile ?? '').trim() };
      }
      return { desktop: '', mobile: '' };
    })
    .filter((s) => s.desktop.length > 0)
    .slice(0, 10);
}

export function useLandingConfig() {
  const tenant = useTenant();
  const config = (tenant.config ?? {}) as Record<string, unknown>;
  const landing = (config.landing ?? {}) as Record<string, unknown>;
  const contactoRaw = (config.contacto ?? {}) as Record<string, unknown>;

  const hero = parseObject(landing.hero, HERO_DEFAULT);
  hero.imagenes = parseHeroSlides(hero.imagenes);
  const secciones = parseSecciones(landing.secciones);
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
    secciones,
    post_hero,
    cta_final,
    footer,
    faq,
    contacto,
    mostrarInstructores,
    whatsappUrl
  };
}
