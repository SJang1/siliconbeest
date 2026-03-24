import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('GET /api/v1/instance', () => {
  beforeAll(async () => {
    await applyMigration();
    // Create an admin user so contact_account can be populated
    await createTestUser('admin', { role: 'admin' });
  });

  it('returns 200 without auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    expect(res.status).toBe(200);
  });

  it('has uri matching instance domain', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.uri).toBe(DOMAIN);
  });

  it('has title', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.title).toBeDefined();
    expect(typeof body.title).toBe('string');
    expect(body.title.length).toBeGreaterThan(0);
  });

  it('has version containing SiliconBeest', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.version).toBeDefined();
    expect(body.version).toContain('SiliconBeest');
  });

  it('has stats with user_count, status_count, domain_count', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.stats).toBeDefined();
    expect(typeof body.stats.user_count).toBe('number');
    expect(typeof body.stats.status_count).toBe('number');
    expect(typeof body.stats.domain_count).toBe('number');
  });

  it('has description', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.description).toBeDefined();
    expect(typeof body.description).toBe('string');
  });

  it('has short_description', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.short_description).toBeDefined();
  });

  it('has email', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.email).toBeDefined();
    expect(typeof body.email).toBe('string');
  });

  it('has urls with streaming_api', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.urls).toBeDefined();
    expect(body.urls.streaming_api).toContain('wss://');
    expect(body.urls.streaming_api).toContain(DOMAIN);
  });

  it('has thumbnail', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.thumbnail).toBeDefined();
    expect(body.thumbnail).toContain(DOMAIN);
  });

  it('has languages array', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.languages).toBeDefined();
    expect(Array.isArray(body.languages)).toBe(true);
    expect(body.languages.length).toBeGreaterThan(0);
  });

  it('has registrations boolean', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(typeof body.registrations).toBe('boolean');
    // REGISTRATION_MODE is 'open' in test config
    expect(body.registrations).toBe(true);
  });

  it('has approval_required boolean', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(typeof body.approval_required).toBe('boolean');
  });

  it('has rules array', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.rules).toBeDefined();
    expect(Array.isArray(body.rules)).toBe(true);
  });

  it('has configuration section', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.configuration).toBeDefined();
    expect(body.configuration.statuses).toBeDefined();
    expect(body.configuration.statuses.max_characters).toBe(500);
    expect(body.configuration.statuses.max_media_attachments).toBe(4);
    expect(body.configuration.media_attachments).toBeDefined();
    expect(body.configuration.media_attachments.supported_mime_types).toBeDefined();
    expect(body.configuration.polls).toBeDefined();
    expect(body.configuration.polls.max_options).toBe(4);
    expect(body.configuration.accounts).toBeDefined();
  });

  it('has contact_account for admin user', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    expect(body.contact_account).toBeDefined();
    expect(body.contact_account).not.toBeNull();
    expect(body.contact_account.username).toBe('admin');
    expect(body.contact_account.acct).toBe('admin');
  });

  it('contact_account has expected fields', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/instance`);
    const body = await res.json<any>();
    const ca = body.contact_account;
    if (ca) {
      expect(ca).toHaveProperty('id');
      expect(ca).toHaveProperty('username');
      expect(ca).toHaveProperty('acct');
      expect(ca).toHaveProperty('display_name');
      expect(ca).toHaveProperty('note');
      expect(ca).toHaveProperty('url');
      expect(ca).toHaveProperty('created_at');
      expect(ca).toHaveProperty('emojis');
      expect(ca).toHaveProperty('fields');
    }
  });
});
