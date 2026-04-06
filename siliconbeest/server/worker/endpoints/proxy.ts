/**
 * Media Proxy Endpoint
 *
 * Implements JIT (Just-In-Time) Proxying for remote Fediverse media and custom emojis.
 * This is the preferred paradigm for Fediverse implementations (Misskey, GoToSocial, etc.)
 * because it:
 *   - Eliminates storage bloat from caching remote emojis
 *   - Reduces database churn during federation ingestion
 *   - Maintains privacy by serving media through our domain
 *   - Allows graceful degradation if remote servers go offline
 *
 * Caching Strategy: Cloudflare CDN Cache
 *   - All responses cached at Cloudflare edge nodes globally
 *   - Automatic cache invalidation based on Cache-Control headers
 *   - Zero database/R2 storage required
 *   - Instant availability across CDN
 *
 * Security:
 *   - SSRF Protection: Blocks localhost, private IPs, and RFC1918 ranges
 *   - Content-Type Validation: Only image/*, video/*, audio/* allowed
 *   - SVG Sandboxing: SVGs returned with X-Content-Type-Options: nosniff
 *   - Size Limits: No cache for files >50MB (proxy directly)
 *   - Timeout Protection: 10-second fetch timeout
 */

import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppVariables } from '../types';

const app = new Hono<{ Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CACHE_SIZE = 50 * 1024 * 1024; // 50 MB
const FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_CONTENT_TYPE_PREFIXES = ['image/', 'video/', 'audio/', 'application/octet-stream'];

// Cache headers for different response types
const CACHE_CONTROL_CACHED = 'public, max-age=2592000, immutable'; // 30 days for cached media
const CACHE_CONTROL_SKIPPED = 'public, max-age=3600'; // 1 hour for large files (proxied through)

// Dangerous MIME types that should never be proxied
const DANGEROUS_MIME_TYPES = [
  'text/html',
  'application/javascript',
  'application/x-javascript',
  'text/javascript',
  'application/xhtml+xml',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a content type is allowed for proxying. */
function isAllowedContentType(ct: string | null): boolean {
  if (!ct) return false;
  const lower = ct.split(';')[0].trim().toLowerCase();

  // Explicitly block dangerous MIME types
  if (DANGEROUS_MIME_TYPES.includes(lower)) {
    return false;
  }

  return ALLOWED_CONTENT_TYPE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Validate that a URL is safe to fetch (http/https only, no private IPs). */
export function isValidProxyUrl(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  // Block URLs with embedded credentials
  if (url.username || url.password) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  // Block private/internal IPs and hostnames
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost')
  ) {
    return false;
  }

  // Block pure numeric hostnames (decimal IP encoding, e.g. 2130706433)
  if (/^\d+$/.test(hostname)) {
    return false;
  }

  // Block hex IP encoding (e.g. 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    return false;
  }

  // Block DNS rebinding services
  if (
    hostname.endsWith('.nip.io') ||
    hostname.endsWith('.sslip.io') ||
    hostname.endsWith('.localtest.me') ||
    hostname.endsWith('.lvh.me')
  ) {
    return false;
  }

  // Block private IP ranges (IPv4)
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local
      a === 0
    ) {
      return false;
    }
  }

  // Block IPv6 private/reserved addresses
  // Strip brackets that URL parser may include
  const bareHost = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (
    bareHost.startsWith('fd') ||
    bareHost.startsWith('fc') ||
    bareHost.startsWith('fe80:') ||
    bareHost.startsWith('::ffff:127.') ||
    bareHost.startsWith('::ffff:10.') ||
    bareHost.startsWith('::ffff:192.168.') ||
    // Some runtimes normalize ::ffff:A.B.C.D to ::ffff:XXYY:ZZWW hex form.
    // Block all IPv4-mapped IPv6 addresses and re-check the embedded IPv4.
    bareHost.startsWith('::ffff:')
  ) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// GET /proxy?url=...
// ---------------------------------------------------------------------------

/**
 * Media Proxy Endpoint using Cloudflare CDN Caching
 *
 * When a client requests /proxy?url=https://remote.server/emoji.png:
 * 1. Request hits Cloudflare edge node
 * 2. If in edge cache: return immediately (Cloudflare serves cached response)
 * 3. If cache miss: fetch from origin, validate, return with cache headers
 * 4. Cloudflare automatically caches response based on Cache-Control header
 * 5. Next request from any user served from edge cache (global CDN)
 *
 * Benefits over R2+D1 caching:
 * - Zero database writes
 * - Zero R2 storage
 * - Automatic edge caching at all Cloudflare locations
 * - Global CDN distribution
 * - 30-day edge cache for validated media
 */
app.get('/', async (c) => {
  const remoteUrl = c.req.query('url');
  function _createProxyHeaders(contentType: string | null, cacheControl: string): Headers {
    const headers = new Headers();
    headers.set('Content-Type', contentType || 'application/octet-stream');
    headers.set('Cache-Control', cacheControl);
    if (contentType === 'image/svg+xml') {
      headers.set('X-Content-Type-Options', 'nosniff');
    }
    return headers;
  }

  // Validate URL param
  if (!remoteUrl) {
    return c.json({ error: 'Missing url parameter' }, 400);
  }

  if (!isValidProxyUrl(remoteUrl)) {
    return c.json({ error: 'Invalid or disallowed URL' }, 400);
  }

  // Fetch from origin with timeout
  let originResponse: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    originResponse = await fetch(remoteUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SiliconBeest/1.0 (+https://' + env.INSTANCE_DOMAIN + '/)',
        Accept: 'image/*,video/*,audio/*,*/*',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);
  } catch (err) {
    return c.json({ error: 'Failed to fetch remote media' }, 502);
  }

  if (!originResponse.ok) {
    // Pass through the original status code (404, 403, 410, etc.) instead of always 502
    const status = originResponse.status >= 400 && originResponse.status < 600
      ? originResponse.status
      : 502;
    return c.json({ error: `Remote server returned ${originResponse.status}` }, status as ContentfulStatusCode);
  }

  const contentType = originResponse.headers.get('Content-Type');

  // Validate content type
  if (!isAllowedContentType(contentType)) {
    return c.json({ error: 'Content type not allowed for proxying' }, 403);
  }

  // Check size from Content-Length header (if available)
  const contentLength = originResponse.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_CACHE_SIZE) {
    // Too large to cache with long TTL — serve through with short TTL
    const headers = _createProxyHeaders(contentType, CACHE_CONTROL_SKIPPED);
    return new Response(originResponse.body, { status: 200, headers });
  }

  // Read full body to check actual size
  const bodyBuffer = await originResponse.arrayBuffer();

  if (bodyBuffer.byteLength > MAX_CACHE_SIZE) {
    // Large file — serve with short TTL
    const headers = _createProxyHeaders(contentType, CACHE_CONTROL_SKIPPED);
    if (contentType === 'image/svg+xml') {
      headers.set('X-Content-Type-Options', 'nosniff');
    }
    return new Response(bodyBuffer, { status: 200, headers });
  }

  // Small file — cache in Cloudflare edge with long TTL
  const resolvedContentType = contentType || 'application/octet-stream';
  const responseHeaders = new Headers();
  responseHeaders.set('Content-Type', resolvedContentType);
  responseHeaders.set('Cache-Control', CACHE_CONTROL_CACHED); // 30 days edge cache
  if (resolvedContentType === 'image/svg+xml') {
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
  }

  // Cloudflare CDN will automatically cache this response based on Cache-Control header
  return new Response(bodyBuffer, { status: 200, headers: responseHeaders });
});

export default app;
