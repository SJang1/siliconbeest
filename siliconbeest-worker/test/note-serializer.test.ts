import { describe, it, expect } from 'vitest';
import { serializeNote } from '../src/federation/noteSerializer';
import type { AccountRow, StatusRow, MentionRow, TagRow } from '../src/types/db';

const DOMAIN = 'test.siliconbeest.local';
const NOW = '2025-01-15T12:00:00.000Z';
const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

function makeAccount(overrides?: Partial<AccountRow>): AccountRow {
  return {
    id: 'acct-001',
    username: 'alice',
    domain: null,
    display_name: 'Alice',
    note: '',
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

function makeStatus(overrides?: Partial<StatusRow>): StatusRow {
  return {
    id: 'status-001',
    uri: `https://${DOMAIN}/users/alice/statuses/status-001`,
    url: `https://${DOMAIN}/@alice/status-001`,
    account_id: 'acct-001',
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    reblog_of_id: null,
    text: 'Hello world',
    content: '<p>Hello world</p>',
    content_warning: '',
    visibility: 'public',
    sensitive: 0,
    language: 'en',
    conversation_id: null,
    reply: 0,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    local: 1,
    federated_at: null,
    edited_at: null,
    deleted_at: null,
    poll_id: null,
    quote_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe('serializeNote', () => {
  it('produces valid Note with @context, id, and type', () => {
    const note = serializeNote(makeStatus(), makeAccount(), DOMAIN);

    expect(note['@context']).toBeDefined();
    expect(Array.isArray(note['@context'])).toBe(true);
    expect(note.id).toBe(`https://${DOMAIN}/users/alice/statuses/status-001`);
    expect(note.type).toBe('Note');
    expect(note.attributedTo).toBe(`https://${DOMAIN}/users/alice`);
  });

  // ---------------------------------------------------------------
  // Visibility / Addressing
  // ---------------------------------------------------------------
  describe('to/cc addressing', () => {
    it('public: to=AS_PUBLIC, cc includes followers', () => {
      const note = serializeNote(makeStatus({ visibility: 'public' }), makeAccount(), DOMAIN);

      expect(note.to).toContain(AS_PUBLIC);
      expect(note.cc).toContain(`https://${DOMAIN}/users/alice/followers`);
    });

    it('unlisted: to=followers, cc includes AS_PUBLIC', () => {
      const note = serializeNote(makeStatus({ visibility: 'unlisted' }), makeAccount(), DOMAIN);

      expect(note.to).toContain(`https://${DOMAIN}/users/alice/followers`);
      expect(note.cc).toContain(AS_PUBLIC);
    });

    it('private: to=followers, cc has no AS_PUBLIC', () => {
      const note = serializeNote(makeStatus({ visibility: 'private' }), makeAccount(), DOMAIN);

      expect(note.to).toContain(`https://${DOMAIN}/users/alice/followers`);
      expect(note.cc).not.toContain(AS_PUBLIC);
    });

    it('direct: to=mentioned users only, cc is empty', () => {
      const mentions = [{
        id: 'm-1',
        status_id: 'status-001',
        account_id: 'acct-bob',
        silent: 0,
        created_at: NOW,
        actor_uri: 'https://remote.example/users/bob',
        acct: 'bob@remote.example',
      }] as unknown as MentionRow[];

      const note = serializeNote(
        makeStatus({ visibility: 'direct' }),
        makeAccount(),
        DOMAIN,
        { mentions },
      );

      expect(note.to).toContain('https://remote.example/users/bob');
      expect(note.to).not.toContain(AS_PUBLIC);
      expect(note.cc).toEqual([]);
    });
  });

  // ---------------------------------------------------------------
  // Sensitive
  // ---------------------------------------------------------------
  it('sensitive flag is always boolean', () => {
    const noteSensitive = serializeNote(makeStatus({ sensitive: 1 }), makeAccount(), DOMAIN);
    expect(noteSensitive.sensitive).toBe(true);
    expect(typeof noteSensitive.sensitive).toBe('boolean');

    const noteNotSensitive = serializeNote(makeStatus({ sensitive: 0 }), makeAccount(), DOMAIN);
    expect(noteNotSensitive.sensitive).toBe(false);
    expect(typeof noteNotSensitive.sensitive).toBe('boolean');
  });

  // ---------------------------------------------------------------
  // inReplyTo
  // ---------------------------------------------------------------
  describe('inReplyTo handling', () => {
    it('sets inReplyTo from URI when it starts with http', () => {
      const status = makeStatus({
        in_reply_to_id: 'https://remote.example/users/bob/statuses/123',
      });
      const note = serializeNote(status, makeAccount(), DOMAIN);

      expect(note.inReplyTo).toBe('https://remote.example/users/bob/statuses/123');
    });

    it('generates local URI when in_reply_to_id is an ID', () => {
      const status = makeStatus({ in_reply_to_id: 'parent-status-id' });
      const note = serializeNote(status, makeAccount(), DOMAIN);

      expect(note.inReplyTo).toBe(`https://${DOMAIN}/users/alice/statuses/parent-status-id`);
    });

    it('sets inReplyTo to null when no in_reply_to_id', () => {
      const note = serializeNote(makeStatus(), makeAccount(), DOMAIN);

      expect(note.inReplyTo).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // Conversation
  // ---------------------------------------------------------------
  describe('conversation field', () => {
    it('generates tag: URI format for local conversations', () => {
      const status = makeStatus({ conversation_id: 'conv-001' });
      const note = serializeNote(status, makeAccount(), DOMAIN);

      expect(note.conversation).toBeDefined();
      expect(note.conversation).toMatch(/^tag:test\.siliconbeest\.local,\d{4}:objectId=conv-001:objectType=Conversation$/);
    });

    it('uses provided AP URI for conversation', () => {
      const status = makeStatus({ conversation_id: 'conv-002' });
      const note = serializeNote(status, makeAccount(), DOMAIN, {
        conversationApUri: 'tag:remote.example,2025:objectId=abc:objectType=Conversation',
      });

      expect(note.conversation).toBe('tag:remote.example,2025:objectId=abc:objectType=Conversation');
    });

    it('omits conversation when conversation_id is null', () => {
      const note = serializeNote(makeStatus({ conversation_id: null }), makeAccount(), DOMAIN);

      expect(note.conversation).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  // Misskey compatibility
  // ---------------------------------------------------------------
  it('includes _misskey_content when text is present', () => {
    const status = makeStatus({ text: 'Hello world' });
    const note = serializeNote(status, makeAccount(), DOMAIN);

    expect(note._misskey_content).toBe('Hello world');
  });

  it('includes _misskey_summary when content_warning is present', () => {
    const status = makeStatus({ content_warning: 'CW: spoiler' });
    const note = serializeNote(status, makeAccount(), DOMAIN);

    expect(note._misskey_summary).toBe('CW: spoiler');
  });

  it('omits _misskey_summary when content_warning is empty', () => {
    const status = makeStatus({ content_warning: '' });
    const note = serializeNote(status, makeAccount(), DOMAIN);

    expect(note._misskey_summary).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // Quote posts (FEP-e232)
  // ---------------------------------------------------------------
  it('includes quoteUri and _misskey_quote when quote_id present', () => {
    const quoteUri = `https://${DOMAIN}/users/bob/statuses/quoted-001`;
    const note = serializeNote(makeStatus(), makeAccount(), DOMAIN, { quoteUri });

    expect(note.quoteUri).toBe(quoteUri);
    expect(note._misskey_quote).toBe(quoteUri);
  });

  it('omits quoteUri when not provided', () => {
    const note = serializeNote(makeStatus(), makeAccount(), DOMAIN);

    expect(note.quoteUri).toBeUndefined();
    expect(note._misskey_quote).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // Mention tags
  // ---------------------------------------------------------------
  it('includes mention tags with Mention type', () => {
    const mentions = [{
      id: 'm-1',
      status_id: 'status-001',
      account_id: 'acct-bob',
      silent: 0,
      created_at: NOW,
      actor_uri: 'https://remote.example/users/bob',
      acct: 'bob@remote.example',
    }] as unknown as MentionRow[];

    const note = serializeNote(makeStatus(), makeAccount(), DOMAIN, { mentions });

    expect(note.tag).toBeDefined();
    expect(note.tag!.length).toBe(1);
    expect(note.tag![0].type).toBe('Mention');
    expect(note.tag![0].href).toBe('https://remote.example/users/bob');
    expect(note.tag![0].name).toBe('@bob@remote.example');
  });

  // ---------------------------------------------------------------
  // Hashtag tags
  // ---------------------------------------------------------------
  it('includes hashtag tags with Hashtag type and # prefix', () => {
    const tags: TagRow[] = [{
      id: 'tag-1',
      name: 'fediverse',
      display_name: 'fediverse',
      usable: 1,
      trendable: 1,
      listable: 1,
      last_status_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    }];

    const note = serializeNote(makeStatus(), makeAccount(), DOMAIN, { tags });

    expect(note.tag).toBeDefined();
    const hashtagTag = note.tag!.find((t) => t.type === 'Hashtag');
    expect(hashtagTag).toBeDefined();
    expect(hashtagTag!.name).toBe('#fediverse');
    expect(hashtagTag!.href).toBe(`https://${DOMAIN}/tags/fediverse`);
  });

  // ---------------------------------------------------------------
  // Media attachments
  // ---------------------------------------------------------------
  it('includes media attachments as Document type', () => {
    const attachments = [
      {
        url: 'https://cdn.example.com/media/photo.jpg',
        mediaType: 'image/jpeg',
        description: 'A nice photo',
        width: 1920,
        height: 1080,
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        type: 'image',
      },
    ];

    const note = serializeNote(makeStatus(), makeAccount(), DOMAIN, { attachments });

    expect(note.attachment).toBeDefined();
    expect(note.attachment!.length).toBe(1);
    const att = note.attachment![0];
    expect(att.type).toBe('Image');
    expect(att.mediaType).toBe('image/jpeg');
    expect(att.url).toBe('https://cdn.example.com/media/photo.jpg');
    expect(att.name).toBe('A nice photo');
    expect(att.width).toBe(1920);
    expect(att.height).toBe(1080);
    expect(att.blurhash).toBe('LEHV6nWB2yk8pyo0adR*.7kCMdnj');
  });

  it('maps video type correctly', () => {
    const attachments = [{
      url: 'https://cdn.example.com/media/clip.mp4',
      mediaType: 'video/mp4',
      description: '',
      type: 'video',
    }];
    const note = serializeNote(makeStatus(), makeAccount(), DOMAIN, { attachments });

    expect(note.attachment![0].type).toBe('Video');
  });

  it('maps audio type correctly', () => {
    const attachments = [{
      url: 'https://cdn.example.com/media/track.mp3',
      mediaType: 'audio/mpeg',
      description: '',
      type: 'audio',
    }];
    const note = serializeNote(makeStatus(), makeAccount(), DOMAIN, { attachments });

    expect(note.attachment![0].type).toBe('Audio');
  });

  it('maps unknown type to Document', () => {
    const attachments = [{
      url: 'https://cdn.example.com/media/file.bin',
      mediaType: 'application/octet-stream',
      description: '',
      type: 'unknown',
    }];
    const note = serializeNote(makeStatus(), makeAccount(), DOMAIN, { attachments });

    expect(note.attachment![0].type).toBe('Document');
  });

  // ---------------------------------------------------------------
  // Content map and source
  // ---------------------------------------------------------------
  it('includes contentMap when language is set', () => {
    const status = makeStatus({ language: 'ko', content: '<p>안녕하세요</p>' });
    const note = serializeNote(status, makeAccount(), DOMAIN);

    expect(note.contentMap).toEqual({ ko: '<p>안녕하세요</p>' });
  });

  it('includes source with text/plain mediaType', () => {
    const status = makeStatus({ text: 'Plain text content' });
    const note = serializeNote(status, makeAccount(), DOMAIN);

    expect(note.source).toBeDefined();
    expect(note.source!.content).toBe('Plain text content');
    expect(note.source!.mediaType).toBe('text/plain');
  });

  it('includes updated field when edited_at is set', () => {
    const editedAt = '2025-01-16T00:00:00.000Z';
    const status = makeStatus({ edited_at: editedAt });
    const note = serializeNote(status, makeAccount(), DOMAIN);

    expect(note.updated).toBe(editedAt);
  });
});
