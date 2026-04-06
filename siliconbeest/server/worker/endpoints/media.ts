import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../types';

const app = new Hono<{ Variables: AppVariables }>();

/**
 * GET /media/:path+ — Serve media from R2 bucket
 * Supports paths like /media/ACCOUNT_ID/MEDIA_ID.jpg
 * Also handles legacy /media/media/... double-prefix paths
 */
app.get('/*', async (c) => {
  let key = c.req.path.replace(/^\/media\//, '');

  // Handle legacy double-prefix: /media/media/ACCOUNT_ID/... → ACCOUNT_ID/...
  if (key.startsWith('media/')) {
    key = key.replace(/^media\//, '');
  }

  if (!key) {
    return c.json({ error: 'Not found' }, 404);
  }

  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) {
    return c.json({ error: 'Not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);

  // Handle conditional requests
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { status: 200, headers });
});

export default app;
