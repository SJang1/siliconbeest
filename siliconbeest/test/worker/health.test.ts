import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration } from './helpers';

describe('Health Check', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  it('GET /healthz returns 200 with "ok"', async () => {
    const res = await SELF.fetch('https://test.siliconbeest.local/healthz');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('ok');
  });

  it('GET /unknown-path returns 404 with Mastodon-compatible error', async () => {
    const res = await SELF.fetch('https://test.siliconbeest.local/totally-unknown');
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('Record not found');
  });
});
