import { describe, it, expect } from 'vitest';
import { serializeActor } from '../src/federation/actorSerializer';
import type { AccountRow, ActorKeyRow, CustomEmojiRow } from '../src/types/db';

const DOMAIN = 'test.siliconbeest.local';
const NOW = '2025-01-15T12:00:00.000Z';

function makeAccount(overrides?: Partial<AccountRow>): AccountRow {
  return {
    id: 'acct-001',
    username: 'alice',
    domain: null,
    display_name: 'Alice',
    note: 'Hello, I am Alice.',
    uri: `https://${DOMAIN}/users/alice`,
    url: `https://${DOMAIN}/@alice`,
    avatar_url: '',
    avatar_static_url: '',
    header_url: '',
    header_static_url: '',
    locked: 0,
    bot: 0,
    discoverable: 1,
    manually_approves_followers: 0,
    statuses_count: 10,
    followers_count: 5,
    following_count: 3,
    last_status_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    suspended_at: null,
    silenced_at: null,
    memorial: 0,
    moved_to_account_id: null,
    ...overrides,
  };
}

function makeActorKey(overrides?: Partial<ActorKeyRow>): ActorKeyRow {
  return {
    id: 'key-001',
    account_id: 'acct-001',
    public_key: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...\n-----END PUBLIC KEY-----',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----',
    key_id: `https://${DOMAIN}/users/alice#main-key`,
    ed25519_public_key: null,
    ed25519_private_key: null,
    created_at: NOW,
    ...overrides,
  };
}

describe('serializeActor', () => {
  it('produces valid JSON-LD with @context', () => {
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN);

    expect(actor['@context']).toBeDefined();
    expect(Array.isArray(actor['@context'])).toBe(true);
    const ctx = actor['@context'] as unknown[];
    expect(ctx).toContain('https://www.w3.org/ns/activitystreams');
    expect(ctx).toContain('https://w3id.org/security/v1');
  });

  it('includes publicKey with id, owner, and publicKeyPem', () => {
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN);

    expect(actor.publicKey).toBeDefined();
    expect(actor.publicKey!.id).toBe(`https://${DOMAIN}/users/alice#main-key`);
    expect(actor.publicKey!.owner).toBe(`https://${DOMAIN}/users/alice`);
    expect(actor.publicKey!.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('includes assertionMethod when Ed25519 key is present', () => {
    // Use a base64url-encoded 32-byte key (simulated)
    const ed25519Key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const actorKey = makeActorKey({ ed25519_public_key: ed25519Key });
    const actor = serializeActor(makeAccount(), actorKey, DOMAIN);

    expect(actor.assertionMethod).toBeDefined();
    expect(Array.isArray(actor.assertionMethod)).toBe(true);
    expect(actor.assertionMethod!.length).toBe(1);

    const am = actor.assertionMethod![0];
    expect(am.type).toBe('Multikey');
    expect(am.id).toBe(`https://${DOMAIN}/users/alice#ed25519-key`);
    expect(am.controller).toBe(`https://${DOMAIN}/users/alice`);
    expect(am.publicKeyMultibase).toBeDefined();
    expect(typeof am.publicKeyMultibase).toBe('string');
  });

  it('omits assertionMethod when no Ed25519 key', () => {
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN);

    expect(actor.assertionMethod).toBeUndefined();
  });

  it('includes icon when avatar_url is present', () => {
    const account = makeAccount({ avatar_url: 'https://cdn.example.com/avatar.png' });
    const actor = serializeActor(account, makeActorKey(), DOMAIN);

    expect(actor.icon).toBeDefined();
    expect(actor.icon!.type).toBe('Image');
    expect(actor.icon!.url).toBe('https://cdn.example.com/avatar.png');
  });

  it('omits icon when avatar_url is empty', () => {
    const account = makeAccount({ avatar_url: '' });
    const actor = serializeActor(account, makeActorKey(), DOMAIN);

    expect(actor.icon).toBeUndefined();
  });

  it('includes image when header_url is present', () => {
    const account = makeAccount({ header_url: 'https://cdn.example.com/header.png' });
    const actor = serializeActor(account, makeActorKey(), DOMAIN);

    expect(actor.image).toBeDefined();
    expect(actor.image!.type).toBe('Image');
    expect(actor.image!.url).toBe('https://cdn.example.com/header.png');
  });

  it('omits image when header_url is empty', () => {
    const account = makeAccount({ header_url: '' });
    const actor = serializeActor(account, makeActorKey(), DOMAIN);

    expect(actor.image).toBeUndefined();
  });

  it('includes alsoKnownAs when provided', () => {
    const aliases = ['https://other.social/users/alice'];
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN, { alsoKnownAs: aliases });

    expect(actor.alsoKnownAs).toEqual(aliases);
  });

  it('defaults alsoKnownAs to empty array', () => {
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN);

    expect(actor.alsoKnownAs).toEqual([]);
  });

  it('includes PropertyValue attachments for profile fields', () => {
    const fields = JSON.stringify([
      { name: 'Website', value: '<a href="https://alice.dev">alice.dev</a>' },
      { name: 'Pronouns', value: 'she/her' },
    ]);
    const account = makeAccount() as Record<string, unknown>;
    account.fields = fields;
    const actor = serializeActor(account as unknown as AccountRow, makeActorKey(), DOMAIN);

    expect(actor.attachment).toBeDefined();
    expect(Array.isArray(actor.attachment)).toBe(true);
    expect(actor.attachment!.length).toBe(2);
    expect(actor.attachment![0]).toEqual({
      type: 'PropertyValue',
      name: 'Website',
      value: '<a href="https://alice.dev">alice.dev</a>',
    });
    expect(actor.attachment![1]).toEqual({
      type: 'PropertyValue',
      name: 'Pronouns',
      value: 'she/her',
    });
  });

  it('omits attachment when fields JSON is absent', () => {
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN);

    expect(actor.attachment).toBeUndefined();
  });

  it('uses Person type for regular user', () => {
    const account = makeAccount({ bot: 0 });
    const actor = serializeActor(account, makeActorKey(), DOMAIN);

    expect(actor.type).toBe('Person');
  });

  it('uses Service type for bot account', () => {
    const account = makeAccount({ bot: 1 });
    const actor = serializeActor(account, makeActorKey(), DOMAIN);

    expect(actor.type).toBe('Service');
  });

  it('sets correct inbox, outbox, followers, following URIs', () => {
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN);

    expect(actor.inbox).toBe(`https://${DOMAIN}/users/alice/inbox`);
    expect(actor.outbox).toBe(`https://${DOMAIN}/users/alice/outbox`);
    expect(actor.followers).toBe(`https://${DOMAIN}/users/alice/followers`);
    expect(actor.following).toBe(`https://${DOMAIN}/users/alice/following`);
  });

  it('sets manuallyApprovesFollowers correctly', () => {
    const unlocked = serializeActor(makeAccount({ manually_approves_followers: 0 }), makeActorKey(), DOMAIN);
    expect(unlocked.manuallyApprovesFollowers).toBe(false);

    const locked = serializeActor(makeAccount({ manually_approves_followers: 1 }), makeActorKey(), DOMAIN);
    expect(locked.manuallyApprovesFollowers).toBe(true);
  });

  it('sets discoverable correctly', () => {
    const visible = serializeActor(makeAccount({ discoverable: 1 }), makeActorKey(), DOMAIN);
    expect(visible.discoverable).toBe(true);

    const hidden = serializeActor(makeAccount({ discoverable: 0 }), makeActorKey(), DOMAIN);
    expect(hidden.discoverable).toBe(false);
  });

  it('includes custom emoji tags when provided', () => {
    const emojis: CustomEmojiRow[] = [
      {
        id: 'emoji-1',
        shortcode: 'blobcat',
        domain: null,
        image_key: 'https://cdn.example.com/emoji/blobcat.png',
        visible_in_picker: 1,
        category: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ];
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN, { customEmojis: emojis });

    expect(actor.tag).toBeDefined();
    expect(actor.tag!.length).toBe(1);
    expect(actor.tag![0].type).toBe('Emoji');
    expect(actor.tag![0].name).toBe(':blobcat:');
    expect(actor.tag![0].icon).toBeDefined();
    expect(actor.tag![0].icon!.url).toBe('https://cdn.example.com/emoji/blobcat.png');
  });

  it('sets featured and featuredTags URIs', () => {
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN);

    expect(actor.featured).toBe(`https://${DOMAIN}/users/alice/collections/featured`);
    expect(actor.featuredTags).toBe(`https://${DOMAIN}/users/alice/collections/tags`);
  });

  it('sets sharedInbox endpoint', () => {
    const actor = serializeActor(makeAccount(), makeActorKey(), DOMAIN);

    expect(actor.endpoints).toBeDefined();
    expect(actor.endpoints!.sharedInbox).toBe(`https://${DOMAIN}/inbox`);
  });
});
