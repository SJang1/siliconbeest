// SiliconBeest — Unified Entry Point
//
// Routes requests between the Hono worker app (API, federation, media)
// and the SPA assets handler. Crawler requests on SPA paths get
// OG meta tags for link previews.

import { env } from 'cloudflare:workers';
import app from './worker/index';
import { isCrawler, handleOgRequest } from './og-handler';
import {
  injectActivityPubAlternateHtml,
  resolveActivityPubAlternate,
  type ActivityPubAlternate,
} from './activitypub-alternate';

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
  '/pwa-icon',
  '/internal/',
];

// Paths that are static PWA files — always serve as-is, never SPA fallback
const STATIC_PWA_PATHS = [
  '/manifest.json',
  '/sw.js',
];

function appendHeaderValue(existing: string | null, value: string): string {
  return existing ? `${existing}, ${value}` : value;
}

async function attachActivityPubAlternate(
  url: URL,
  db: D1Database,
  response: Response,
): Promise<Response> {
  const alternate = await resolveActivityPubAlternate(url, db);
  if (!alternate) return response;

  return withActivityPubAlternate(response, alternate);
}

async function withActivityPubAlternate(
  response: Response,
  alternate: ActivityPubAlternate,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set('Link', appendHeaderValue(headers.get('Link'), alternate.headerValue));

  const contentType = headers.get('Content-Type') ?? '';
  const contentEncoding = headers.get('Content-Encoding');
  const shouldInjectHtml =
    contentType.includes('text/html') && !contentEncoding && response.body !== null;

  if (!shouldInjectHtml) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const html = await response.text();
  headers.delete('Content-Length');
  return new Response(injectActivityPubAlternateHtml(html, alternate), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
        if (ogResponse) return attachActivityPubAlternate(url, _env.DB, ogResponse);
      }
    }

    // 3. PWA static files — serve with appropriate headers
    if (STATIC_PWA_PATHS.includes(pathname)) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        const headers = new Headers(assetResponse.headers);
        if (pathname === '/sw.js') {
          headers.set('Service-Worker-Allowed', '/');
          headers.set('Cache-Control', 'no-cache');
          headers.set('Content-Type', 'application/javascript');
        } else if (pathname === '/manifest.json') {
          headers.set('Content-Type', 'application/manifest+json');
        }
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          headers,
        });
      }
    }

    // 4. Try serving static assets
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return attachActivityPubAlternate(url, _env.DB, assetResponse);
    }

    // 5. SPA fallback — serve index.html for client-side routing
    const spaResponse = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    return attachActivityPubAlternate(url, _env.DB, spaResponse);
  },
} satisfies ExportedHandler<Env>;
