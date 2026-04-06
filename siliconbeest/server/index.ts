// SiliconBeest — Unified Entry Point
//
// Routes requests between the Hono worker app (API, federation, media)
// and the SPA assets handler. Crawler requests on SPA paths get
// OG meta tags for link previews.

import { env } from 'cloudflare:workers';
import app from './worker/index';
import { isCrawler, handleOgRequest } from './og-handler';

// Re-export Durable Object class so the runtime can find it
export { StreamingDO } from './worker/durableObjects/streaming';

// Prefixes / paths handled by the Hono worker app
const WORKER_PREFIXES = [
  '/api/',
  '/oauth/',
  '/.well-known/',
  '/nodeinfo',
  '/users/',
  '/actor',
  '/inbox',
  '/media/',
  '/proxy',
  '/authorize_interaction',
  '/auth/confirm',
  '/healthz',
  '/thumbnail.png',
  '/favicon.ico',
  '/default-avatar.svg',
  '/default-header.svg',
  '/internal/',
];

function isWorkerPath(pathname: string, request: Request): boolean {
  for (const prefix of WORKER_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix)) {
      if (pathname.startsWith('/oauth/authorize')) {
        const method = request.method;
        const accept = request.headers.get('Accept') ?? '';
        if (method === 'GET' && !accept.includes('application/json') && !accept.includes('activity+json')) {
          const auth = request.headers.get('Authorization');
          if (!auth) {
            return false;
          }
        }
      }
      return true;
    }
  }
  return false;
}

export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Worker paths → Hono app
    if (isWorkerPath(pathname, request)) {
      return app.fetch(request, _env, ctx);
    }

    // 2. Crawler on SPA paths → OG handler
    const ua = request.headers.get('User-Agent');
    if (isCrawler(ua)) {
      if (!pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|avif|map|json)$/)) {
        const ogResponse = await handleOgRequest(url);
        if (ogResponse) return ogResponse;
      }
    }

    // 3. Try serving static assets
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;

    // 4. SPA fallback — serve index.html for client-side routing
    return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
  },
} satisfies ExportedHandler<Env>;
