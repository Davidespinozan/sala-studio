import type { Plugin, ViteDevServer } from 'vite';
import { loadEnv } from 'vite';

interface NetlifyResult {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Plugin de DEV — sirve las Netlify Functions dentro del propio `npm run dev`.
 *
 * Motivo: netlify-cli no arranca en este entorno (crashea con ECONNRESET, en
 * Node 20 y 24). Para poder probar funciones en local, este plugin intercepta
 * las requests a `/.netlify/functions/*` y ejecuta el handler de la función
 * vía el module loader SSR de Vite.
 *
 * Solo corre en `serve` (dev). El build de producción NO lo toca — en prod las
 * funciones las sirve Netlify de verdad.
 */
export function devFunctionsPlugin(): Plugin {
  return {
    name: 'dev-netlify-functions',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      // Cargar TODAS las env vars (incluidas las sin prefijo VITE_, como
      // SUPABASE_SERVICE_ROLE_KEY) a process.env: las funciones las leen de ahí.
      const env = loadEnv(server.config.mode, process.cwd(), '');
      for (const [clave, valor] of Object.entries(env)) {
        if (process.env[clave] === undefined) process.env[clave] = valor;
      }

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/.netlify/functions/')) {
          next();
          return;
        }
        const nombre = url.slice('/.netlify/functions/'.length).split('?')[0];

        void (async () => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const body = Buffer.concat(chunks).toString('utf8');

            const mod = await server.ssrLoadModule(`/netlify/functions/${nombre}.ts`);
            const handler = (mod as { handler?: unknown }).handler;
            if (typeof handler !== 'function') {
              throw new Error(`La función "${nombre}" no exporta un handler.`);
            }

            const event = {
              httpMethod: req.method ?? 'GET',
              headers: req.headers,
              body: body.length > 0 ? body : null,
              queryStringParameters: {},
              path: url,
              isBase64Encoded: false
            };

            const ejecutar = handler as (e: unknown, c: unknown) => Promise<NetlifyResult>;
            const result = (await ejecutar(event, {})) ?? {};

            res.statusCode = result.statusCode ?? 200;
            for (const [clave, valor] of Object.entries(result.headers ?? {})) {
              res.setHeader(clave, valor);
            }
            res.end(result.body ?? '');
          } catch (e) {
            console.error(`[dev-functions] ${nombre}:`, e);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: e instanceof Error ? e.message : 'dev function runner error'
              })
            );
          }
        })();
      });
    }
  };
}
