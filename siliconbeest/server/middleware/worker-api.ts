import { defineEventHandler, toWebRequest } from 'h3';
import app from '../worker/index';
import {
  injectActivityPubAlternateHtml,
  resolveActivityPubAlternate,
  type ActivityPubAlternate,
} from '../activitypub-alternate';
import { handleOgRequest, isCrawler } from '../og-handler';

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

function appendHeaderValue(existing: string | null, value: string): string {
  return existing ? `${existing}, ${value}` : value;
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

async function attachActivityPubAlternate(
  url: URL,
  db: D1Database | undefined,
  response: Response,
): Promise<Response> {
  if (!db) return response;
  const alternate = await resolveActivityPubAlternate(url, db);
  return alternate ? withActivityPubAlternate(response, alternate) : response;
}

function isWorkerPath(pathname: string, request: Request): boolean {
  for (const prefix of WORKER_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix)) {
      if (pathname.startsWith('/oauth/authorize')) {
        const method = request.method;
        const accept = request.headers.get('Accept') ?? '';
        if (method === 'GET' && !accept.includes('application/json') && !accept.includes('activity+json')) {
          const auth = request.headers.get('Authorization');
          if (!auth) return false;
        }
      }
      return true;
    }
  }
  return false;
}

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event);
  const url = new URL(request.url);
  const db = event.context.cloudflare?.env?.DB as D1Database | undefined;

  if (isWorkerPath(url.pathname, request)) {
    return app.fetch(request, event.context.cloudflare?.env, event.context.cloudflare?.context);
  }

  const ua = request.headers.get('User-Agent');
  const isAsset = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|avif|map|json)$/.test(url.pathname);
  if (!isAsset && isCrawler(ua)) {
    const ogResponse = await handleOgRequest(url);
    if (ogResponse) {
      return attachActivityPubAlternate(url, db, ogResponse);
    }
  }
});
