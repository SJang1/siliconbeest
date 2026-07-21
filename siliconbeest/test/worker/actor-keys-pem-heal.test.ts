import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

// Early install/seed scripts wrote actor_keys.ed25519_* as PEM, but the
// runtime importers expect base64url (raw public / PKCS8 private). Rows in
// that state made every getActorKeyPairs() call throw atob
// InvalidCharacterError (500 on actor fetch and on search resolve=true).
// This is a throwaway keypair generated only for this fixture.
const PEM_ED25519_PUBLIC = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEADApTpz0d48jCULibA7idZmNEEra0AZpvhX+9YdzXj1s=\n-----END PUBLIC KEY-----\n';
const PEM_ED25519_PRIVATE = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIH0XnLA+fS67iSPe1vbVbkaxAFE7TDvc4uKhcBD9NFZF\n-----END PRIVATE KEY-----\n';

describe('actor_keys ed25519 PEM self-heal', () => {
  let user: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('pemseeded');
    await env.DB.prepare(
      'UPDATE actor_keys SET ed25519_public_key = ?1, ed25519_private_key = ?2 WHERE account_id = ?3',
    )
      .bind(PEM_ED25519_PUBLIC, PEM_ED25519_PRIVATE, user.accountId)
      .run();
  });

  it('serves the actor document instead of crashing on PEM-seeded ed25519 keys', async () => {
    const res = await SELF.fetch(`${BASE}/users/pemseeded`, {
      headers: { Accept: 'application/activity+json' },
    });
    expect(res.status).toBe(200);

    const body = await res.json<Record<string, unknown>>();
    expect(body.type).toBe('Person');
    expect(body.publicKey).toBeDefined();
    expect(body.assertionMethod).toBeDefined();
  });

  it('rewrites the stored keys to base64url', async () => {
    const row = await env.DB.prepare(
      'SELECT ed25519_public_key, ed25519_private_key FROM actor_keys WHERE account_id = ?1',
    )
      .bind(user.accountId)
      .first<{ ed25519_public_key: string; ed25519_private_key: string }>();

    expect(row).not.toBeNull();
    expect(row!.ed25519_public_key).not.toContain('-----BEGIN');
    expect(row!.ed25519_private_key).not.toContain('-----BEGIN');
    expect(row!.ed25519_public_key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(row!.ed25519_private_key).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
