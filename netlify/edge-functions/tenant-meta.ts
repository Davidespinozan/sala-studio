/**
 * Vista previa al compartir el link de un tenant (WhatsApp, iMessage, redes).
 *
 * Los bots que arman la tarjeta de preview NO ejecutan JavaScript: leen el HTML
 * tal como sale del servidor. Nuestro index.html es estático y trae la marca de
 * SALA, así que el link de cualquier gym se compartía con el logo y el texto de
 * SALA — el branding del tenant lo aplica el front recién en runtime, cuando el
 * bot ya se fue.
 *
 * Esta edge function resuelve el tenant por el SUBDOMINIO (igual que
 * resolveTenantSlug en el front), lo busca en Supabase y reescribe el <head>
 * del HTML con su nombre, su descripción y su imagen. Es la única capa que
 * corre antes de que el bot lea la página.
 *
 * Ante cualquier problema (sin env, tenant inexistente, Supabase lento) devuelve
 * el HTML original intacto: la preview queda como estaba, la app nunca se rompe.
 */

// Hosts del producto SALA (no son tenants) → se comparten con la marca SALA.
const MARKETING_HOSTS = new Set(['salastudio.app', 'www.salastudio.app']);

/** Mismo criterio que resolveTenantSlug(): el primer label del subdominio. */
function slugDesdeHost(host: string): string | null {
  if (MARKETING_HOSTS.has(host)) return null;
  if (host === 'localhost' || host.startsWith('127.') || host.endsWith('.netlify.app')) {
    return null;
  }
  const partes = host.split('.');
  if (partes.length < 3) return null; // apex sin subdominio
  const slug = partes[0];
  return /^[a-z0-9-]+$/i.test(slug) ? slug : null;
}

/** Escapa para meterlo dentro de un atributo HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface TenantPreview {
  nombre: string;
  imagen: string | null;
  color: string | null;
}

async function leerTenant(slug: string): Promise<TenantPreview | null> {
  // deno-lint-ignore no-explicit-any
  const env = (globalThis as any).Netlify?.env;
  const url: string | undefined =
    env?.get('SUPABASE_URL') ?? env?.get('VITE_SUPABASE_URL');
  const key: string | undefined =
    env?.get('SUPABASE_ANON_KEY') ?? env?.get('VITE_SUPABASE_ANON_KEY');
  if (!url || !key) return null;

  const endpoint =
    `${url}/rest/v1/tenants?select=nombre,branding&status=eq.activo` +
    `&slug=eq.${encodeURIComponent(slug)}&limit=1`;

  const res = await fetch(endpoint, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(1500)
  });
  if (!res.ok) return null;

  const filas = (await res.json()) as Array<{
    nombre?: string | null;
    branding?: Record<string, unknown> | null;
  }>;
  const fila = filas[0];
  if (!fila?.nombre) return null;

  const b = fila.branding ?? {};
  const str = (k: string) => (typeof b[k] === 'string' && b[k] ? (b[k] as string) : null);
  return {
    nombre: fila.nombre,
    // og_image_url es la imagen pensada para compartir; si no la cargaron, cae
    // al logo y por último al isotipo.
    imagen: str('og_image_url') ?? str('logo_url') ?? str('isotipo_url'),
    color: str('color_primary')
  };
}

export default async (request: Request, context: { next: () => Promise<Response> }) => {
  const respuesta = await context.next();

  // Solo el documento HTML. Los assets (js/css/imágenes) pasan de largo.
  const tipo = respuesta.headers.get('content-type') ?? '';
  if (!tipo.includes('text/html')) return respuesta;

  const slug = slugDesdeHost(new URL(request.url).hostname);
  if (!slug) return respuesta;

  let tenant: TenantPreview | null = null;
  try {
    tenant = await leerTenant(slug);
  } catch {
    return respuesta; // Supabase caído o lento → preview de SALA, mejor que nada
  }
  if (!tenant) return respuesta;

  const nombre = esc(tenant.nombre);
  const descripcion = esc(`Reserva tus clases en ${tenant.nombre}.`);

  let html = await respuesta.text();

  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${nombre}</title>`)
    .replace(
      /<meta\s+name="description"[^>]*>/i,
      `<meta name="description" content="${descripcion}" />`
    )
    .replace(
      /<meta\s+property="og:title"[^>]*>/i,
      `<meta property="og:title" content="${nombre}" />`
    )
    .replace(
      /<meta\s+property="og:description"[^>]*>/i,
      `<meta property="og:description" content="${descripcion}" />`
    )
    // iOS toma de acá el nombre del ícono al "Agregar a inicio".
    .replace(
      /<meta\s+name="apple-mobile-web-app-title"[^>]*>/i,
      `<meta name="apple-mobile-web-app-title" content="${nombre}" />`
    );

  if (tenant.color) {
    html = html.replace(
      /<meta\s+name="theme-color"[^>]*>/i,
      `<meta name="theme-color" content="${esc(tenant.color)}" />`
    );
  }

  // Las que no existen en el index.html estático se agregan.
  const extra = [
    `<meta property="og:site_name" content="${nombre}" />`,
    `<meta property="og:url" content="${esc(request.url)}" />`,
    tenant.imagen ? `<meta property="og:image" content="${esc(tenant.imagen)}" />` : '',
    tenant.imagen ? `<meta name="twitter:image" content="${esc(tenant.imagen)}" />` : '',
    `<meta name="twitter:card" content="${tenant.imagen ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${nombre}" />`,
    `<meta name="twitter:description" content="${descripcion}" />`
  ]
    .filter(Boolean)
    .join('\n    ');

  html = html.replace('</head>', `    ${extra}\n  </head>`);

  const headers = new Headers(respuesta.headers);
  headers.delete('content-length'); // el cuerpo cambió de tamaño
  return new Response(html, { status: respuesta.status, headers });
};

export const config = {
  path: '/*',
  excludedPath: ['/assets/*', '/icons/*', '/*.js', '/*.css', '/*.png', '/*.svg', '/*.ico']
};
