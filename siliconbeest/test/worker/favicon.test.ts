import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration } from './helpers';

const BASE = 'https://test.siliconbeest.local';

async function setSetting(key: string, value: string) {
  await env.DB_META_C000.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, value).run();
}

describe('Favicon', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  it('serves the uploaded instance favicon from /favicon.ico', async () => {
    await setSetting('site_favicon_url', `${BASE}/favicon.ico`);
    await env.MEDIA_BUCKET.put('instance/favicon.ico', new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/png' },
    });

    const res = await SELF.fetch(`${BASE}/favicon.ico`);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('image/png');
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it('redirects /favicon.ico to a configured custom favicon URL', async () => {
    await setSetting('site_favicon_url', 'https://cdn.example.test/server-favicon.png');

    const res = await SELF.fetch(`${BASE}/favicon.ico`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://cdn.example.test/server-favicon.png');
  });
});
