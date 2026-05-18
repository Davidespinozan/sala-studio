import { useTenant } from '@shared/hooks/useTenant';

type LandingHero = {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  subtitulo: string;
  cta_texto: string;
  cta_link: string;
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
  cta_link: '#membresias'
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

export function useLandingConfig() {
  const tenant = useTenant();
  const config = (tenant.config ?? {}) as Record<string, unknown>;
  const landing = (config.landing ?? {}) as Record<string, unknown>;
  const contactoRaw = (config.contacto ?? {}) as Record<string, unknown>;

  const hero = parseObject(landing.hero, HERO_DEFAULT);
  const cta_final = parseObject(landing.cta_final, CTA_FINAL_DEFAULT);

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

  // Helper: URL completa de WhatsApp con mensaje encoded.
  // Devuelve null si no hay número configurado → render condicional en el consumidor.
  const whatsappUrl = (mensaje?: string): string | null => {
    if (!contacto.whatsapp_e164) return null;
    const msg = encodeURIComponent(mensaje ?? contacto.whatsapp_mensaje_default);
    return `https://wa.me/${contacto.whatsapp_e164}?text=${msg}`;
  };

  return {
    hero,
    cta_final,
    footer,
    contacto,
    whatsappUrl
  };
}
