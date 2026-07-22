import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { canResolveRemoteDomain } from '../../server/worker/services/permissions';
import { applyMigration, createTestUser } from './helpers';

describe('remote resolution permissions', () => {
  let viewerAccountId: string;

  beforeAll(async () => {
    await applyMigration();
    viewerAccountId = (await createTestUser('remote-resolution-viewer')).accountId;
    const now = new Date().toISOString();
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO domain_blocks
         (id, domain, severity, created_at, updated_at)
         VALUES ('remote-resolution-parent', 'blocked.example', 'suspend', ?1, ?1)`,
      ).bind(now),
      env.DB_META_C000.prepare(
        `INSERT INTO domain_blocks
         (id, domain, severity, created_at, updated_at)
         VALUES ('remote-resolution-child', 'allowed.blocked.example', 'noop', ?1, ?1)`,
      ).bind(now),
      env.DB_META_C000.prepare(
        `INSERT INTO user_domain_blocks
         (id, account_id, domain, created_at)
         VALUES ('remote-resolution-user-block', ?1, 'personal.example', ?2)`,
      ).bind(viewerAccountId, now),
    ]);
  });

  it('denies local and globally suspended parent domains with a specific override', async () => {
    expect(await canResolveRemoteDomain(viewerAccountId, env.INSTANCE_DOMAIN)).toBe(false);
    expect(await canResolveRemoteDomain(viewerAccountId, 'sub.blocked.example')).toBe(false);
    expect(await canResolveRemoteDomain(viewerAccountId, 'allowed.blocked.example')).toBe(true);
    expect(await canResolveRemoteDomain(viewerAccountId, 'badblocked.example')).toBe(true);
  });

  it('applies user domain blocks exactly and keeps every value in bindings', async () => {
    expect(await canResolveRemoteDomain(viewerAccountId, 'PERSONAL.EXAMPLE')).toBe(false);
    expect(await canResolveRemoteDomain(viewerAccountId, 'sub.personal.example')).toBe(true);
    expect(await canResolveRemoteDomain("viewer' OR 1=1 --", 'safe.example')).toBe(true);
  });
});
