import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  getSuspendedDomains,
  isDomainBlocked,
} from '../../../packages/shared/domain-blocks';
import { applyMigration } from './helpers';

async function createDomainRule(domain: string, severity: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB_META_C000.prepare(
    `INSERT INTO domain_blocks (
       id, domain, severity, reject_media, reject_reports, created_at, updated_at
     ) VALUES (?1, ?2, ?3, 0, 0, ?4, ?4)`,
  )
    .bind(crypto.randomUUID(), domain, severity, now)
    .run();
}

describe('admin parent-domain permission boundaries', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  it('applies a parent suspension only across DNS label boundaries', async () => {
    await createDomainRule('parent-boundary.example', 'suspend');

    expect((await isDomainBlocked(
      env.DB_META_C000,
      null,
      'sub.parent-boundary.example',
    )).blocked).toBe(true);
    expect((await isDomainBlocked(
      env.DB_META_C000,
      null,
      'badparent-boundary.example',
    )).blocked).toBe(false);

    const suspended = await getSuspendedDomains(env.DB_META_C000, [
      'deep.sub.parent-boundary.example',
      'badparent-boundary.example',
    ]);
    expect(suspended.has('deep.sub.parent-boundary.example')).toBe(true);
    expect(suspended.has('badparent-boundary.example')).toBe(false);
  });

  it('lets a more-specific noop rule override a suspended parent', async () => {
    await createDomainRule('specific-override.example', 'suspend');
    await createDomainRule('allowed.specific-override.example', 'noop');

    expect((await isDomainBlocked(
      env.DB_META_C000,
      null,
      'child.allowed.specific-override.example',
    )).blocked).toBe(false);
    expect((await isDomainBlocked(
      env.DB_META_C000,
      null,
      'blocked.specific-override.example',
    )).blocked).toBe(true);

    const suspended = await getSuspendedDomains(env.DB_META_C000, [
      'child.allowed.specific-override.example',
      'blocked.specific-override.example',
    ]);
    expect(suspended.has('child.allowed.specific-override.example')).toBe(false);
    expect(suspended.has('blocked.specific-override.example')).toBe(true);
  });
});
