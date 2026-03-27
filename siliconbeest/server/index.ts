// SiliconBeest — Unified Entry Point
//
// Routes requests between the Hono worker app (API, federation, media)
// and the SPA assets handler. Crawler requests on SPA paths get
// OG meta tags for link previews.

import app from './worker/index';
import { isCrawler, handleOgRequest } from './og-handler';
import type { Env } from './worker/env';

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
  '/auth/',
  '/healthz',
  '/thumbnail.png',
  '/favicon.ico',
  '/default-avatar.svg',
  '/default-header.svg',
  '/internal/',
];

function isWorkerPath(pathname: string): boolean {
  for (const prefix of WORKER_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Worker paths → Hono app
    if (isWorkerPath(pathname)) {
      return app.fetch(request, env, ctx);
    }

    // 2. Crawler on SPA paths → OG handler
    const ua = request.headers.get('User-Agent');
    if (isCrawler(ua)) {
      // Skip static asset requests — let the assets handler serve them
      if (
        pathname.startsWith('/assets/') ||
        pathname.startsWith('/favicon') ||
        pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|avif|map|json)$/)
      ) {
        return new Response(null, { status: 404 });
      }

      const ogResponse = await handleOgRequest(url, env);
      if (ogResponse) return ogResponse;
    }

    // 3. Everything else → 404 (SPA fallback via assets)
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
