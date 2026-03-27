import { describe, it, expect } from 'vitest';
import {
  serializeAccount,
  serializeStatus,
  serializePoll,
  serializeNotification,
  serializeMediaAttachment,
  serializeRelationship,
  serializeList,
  serializeTag,
  serializeFilter,
  serializeMarker,
} from '../src/utils/mastodonSerializer';
import type { AccountRow, StatusRow, MediaAttachmentRow, NotificationRow, PollRow, ListRow, TagRow, FilterRow, MarkerRow } from '../src/types/db';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAccountRow(overrides?: Partial<AccountRow>): AccountRow {
  return {
    id: 'acct-1',
    username: 'testuser',
    domain: null,
    display_name: 'Test User',
    note: 'A test account',
    uri: 'https://example.com/users/testuser',
    url: 'https://example.com/@testuser',
    avatar_url: 'https://example.com/avatars/test.png',
    avatar_static_url: 'https://example.com/avatars/test_static.png',
    header_url: 'https://example.com/headers/test.png',
    header_static_url: 'https://example.com/headers/test_static.png',
    locked: 0,
    bot: 0,
    discoverable: 1,
    manually_approves_followers: 0,
    statuses_count: 42,
    followers_count: 10,
    following_count: 5,
    last_status_at: '2024-01-01T00:00:00.000Z',
    created_at: '2023-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    suspended_at: null,
    silenced_at: null,
    memorial: 0,
    moved_to_account_id: null,
    ...overrides,
  };
}

function makeStatusRow(overrides?: Partial<StatusRow>): StatusRow {
  return {
    id: 'status-1',
    uri: 'https://example.com/statuses/1',
    url: 'https://example.com/@testuser/1',
    account_id: 'acct-1',
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
    reblogs_count: 3,
    favourites_count: 5,
    local: 1,
    federated_at: null,
    edited_at: null,
    deleted_at: null,
    poll_id: null,
    quote_id: null,
    created_at: '2024-01-01T12:00:00.000Z',
    updated_at: '2024-01-01T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// serializeAccount
// ---------------------------------------------------------------------------
describe('serializeAccount', () => {
  it('converts a local account row to API format', () => {
    const row = makeAccountRow();
    const account = serializeAccount(row);

    expect(account.id).toBe('acct-1');
    expect(account.username).toBe('testuser');
    expect(account.acct).toBe('testuser');
    expect(account.display_name).toBe('Test User');
    expect(account.note).toBe('A test account');
    expect(account.url).toBe('https://example.com/@testuser');
    expect(account.uri).toBe('https://example.com/users/testuser');
    expect(account.avatar).toBe('https://example.com/avatars/test.png');
    expect(account.header).toBe('https://example.com/headers/test.png');
    expect(account.statuses_count).toBe(42);
    expect(account.followers_count).toBe(10);
    expect(account.following_count).toBe(5);
    expect(account.created_at).toBe('2023-01-01T00:00:00.000Z');
  });

  it('uses username@domain for remote accounts', () => {
    const row = makeAccountRow({ domain: 'remote.social' });
    const account = serializeAccount(row);
    expect(account.acct).toBe('testuser@remote.social');
  });

  it('uses just username for local accounts (domain=null)', () => {
    const row = makeAccountRow({ domain: null });
    const account = serializeAccount(row);
    expect(account.acct).toBe('testuser');
  });

  it('uses just username for local accounts (domain="")', () => {
    const row = makeAccountRow({ domain: '' as any });
    const account = serializeAccount(row);
    expect(account.acct).toBe('testuser');
  });

  it('converts 0/1 to boolean for locked', () => {
    expect(serializeAccount(makeAccountRow({ locked: 0 })).locked).toBe(false);
    expect(serializeAccount(makeAccountRow({ locked: 1 })).locked).toBe(true);
  });

  it('converts 0/1 to boolean for bot', () => {
    expect(serializeAccount(makeAccountRow({ bot: 0 })).bot).toBe(false);
    expect(serializeAccount(makeAccountRow({ bot: 1 })).bot).toBe(true);
  });

  it('converts 0/1 to boolean for discoverable', () => {
    expect(serializeAccount(makeAccountRow({ discoverable: 1 })).discoverable).toBe(true);
    expect(serializeAccount(makeAccountRow({ discoverable: 0 })).discoverable).toBe(false);
  });

  it('always sets group to false', () => {
    expect(serializeAccount(makeAccountRow()).group).toBe(false);
  });

  it('includes source when provided', () => {
    const source = { privacy: 'public' as const, sensitive: false, language: 'en', note: '', fields: [] };
    const account = serializeAccount(makeAccountRow(), { source });
    expect(account.source).toBe(source);
  });

  it('sets suspended=true when suspended_at is set', () => {
    const row = makeAccountRow({ suspended_at: '2024-06-01T00:00:00Z' });
    const account = serializeAccount(row);
    expect(account.suspended).toBe(true);
  });

  it('does not set suspended when suspended_at is null', () => {
    const row = makeAccountRow({ suspended_at: null });
    const account = serializeAccount(row);
    expect(account.suspended).toBeUndefined();
  });

  it('uses default avatar when avatar_url is empty', () => {
    const row = makeAccountRow({ avatar_url: '' as any });
    const account = serializeAccount(row);
    expect(account.avatar).toContain('default-avatar');
  });

  it('falls back url to uri when url is null', () => {
    const row = makeAccountRow({ url: null });
    const account = serializeAccount(row);
    expect(account.url).toBe(row.uri);
  });

  it('returns emojis as empty array', () => {
    expect(serializeAccount(makeAccountRow()).emojis).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// serializeStatus
// ---------------------------------------------------------------------------
describe('serializeStatus', () => {
  it('converts a status row to API format', () => {
    const accountRow = makeAccountRow();
    const account = serializeAccount(accountRow);
    const row = makeStatusRow();
    const status = serializeStatus(row, { account });

    expect(status.id).toBe('status-1');
    expect(status.uri).toBe('https://example.com/statuses/1');
    expect(status.url).toBe('https://example.com/@testuser/1');
    expect(status.content).toBe('<p>Hello world</p>');
    expect(status.visibility).toBe('public');
    expect(status.reblogs_count).toBe(3);
    expect(status.favourites_count).toBe(5);
    expect(status.created_at).toBe('2024-01-01T12:00:00.000Z');
    expect(status.account).toBe(account);
  });

  it('converts sensitive from 0/1 to boolean', () => {
    const account = serializeAccount(makeAccountRow());
    const s1 = serializeStatus(makeStatusRow({ sensitive: 0 }), { account });
    expect(s1.sensitive).toBe(false);
    const s2 = serializeStatus(makeStatusRow({ sensitive: 1 }), { account });
    expect(s2.sensitive).toBe(true);
  });

  it('uses content_warning as spoiler_text', () => {
    const account = serializeAccount(makeAccountRow());
    const status = serializeStatus(makeStatusRow({ content_warning: 'CW text' }), { account });
    expect(status.spoiler_text).toBe('CW text');
  });

  it('defaults optional fields', () => {
    const account = serializeAccount(makeAccountRow());
    const status = serializeStatus(makeStatusRow(), { account });
    expect(status.favourited).toBe(false);
    expect(status.reblogged).toBe(false);
    expect(status.bookmarked).toBe(false);
    expect(status.muted).toBe(false);
    expect(status.pinned).toBe(false);
    expect(status.reblog).toBeNull();
    expect(status.poll).toBeNull();
    expect(status.card).toBeNull();
    expect(status.media_attachments).toEqual([]);
    expect(status.emojis).toEqual([]);
    expect(status.tags).toEqual([]);
    expect(status.mentions).toEqual([]);
  });

  it('passes through optional boolean opts', () => {
    const account = serializeAccount(makeAccountRow());
    const status = serializeStatus(makeStatusRow(), {
      account,
      favourited: true,
      reblogged: true,
      bookmarked: true,
      pinned: true,
    });
    expect(status.favourited).toBe(true);
    expect(status.reblogged).toBe(true);
    expect(status.bookmarked).toBe(true);
    expect(status.pinned).toBe(true);
  });

  it('returns null for edited_at when not edited', () => {
    const account = serializeAccount(makeAccountRow());
    const status = serializeStatus(makeStatusRow({ edited_at: null }), { account });
    expect(status.edited_at).toBeNull();
  });

  it('returns edited_at when set', () => {
    const account = serializeAccount(makeAccountRow());
    const status = serializeStatus(makeStatusRow({ edited_at: '2024-06-01T00:00:00Z' }), { account });
    expect(status.edited_at).toBe('2024-06-01T00:00:00Z');
  });

  it('returns text field from row', () => {
    const account = serializeAccount(makeAccountRow());
    const status = serializeStatus(makeStatusRow(), { account });
    // text comes from row.text — our mock has 'Hello world'
    expect(status.text).toBe('Hello world');
  });
});

// ---------------------------------------------------------------------------
// serializePoll
// ---------------------------------------------------------------------------
describe('serializePoll', () => {
  function makePollRow(overrides?: Partial<PollRow>): PollRow {
    return {
      id: 'poll-1',
      status_id: 'status-1',
      expires_at: '2099-12-31T23:59:59Z',
      multiple: 0,
      votes_count: 10,
      voters_count: 8,
      options: JSON.stringify(['Option A', 'Option B']),
      created_at: '2024-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('converts a poll row to API format', () => {
    const poll = serializePoll(makePollRow());
    expect(poll.id).toBe('poll-1');
    expect(poll.votes_count).toBe(10);
    expect(poll.voters_count).toBe(8);
    expect(poll.multiple).toBe(false);
    expect(poll.expired).toBe(false);
    expect(poll.options).toHaveLength(2);
    expect(poll.options[0].title).toBe('Option A');
    expect(poll.emojis).toEqual([]);
  });

  it('parses string options', () => {
    const poll = serializePoll(makePollRow({ options: JSON.stringify(['Yes', 'No']) }));
    expect(poll.options[0]).toEqual({ title: 'Yes', votes_count: null });
    expect(poll.options[1]).toEqual({ title: 'No', votes_count: null });
  });

  it('parses object options with votes_count', () => {
    const opts = [{ title: 'A', votes_count: 5 }, { title: 'B', votes_count: 3 }];
    const poll = serializePoll(makePollRow({ options: JSON.stringify(opts) }));
    expect(poll.options[0]).toEqual({ title: 'A', votes_count: 5 });
    expect(poll.options[1]).toEqual({ title: 'B', votes_count: 3 });
  });

  it('handles invalid JSON in options gracefully', () => {
    const poll = serializePoll(makePollRow({ options: 'not json' }));
    expect(poll.options).toEqual([]);
  });

  it('detects expired polls', () => {
    const poll = serializePoll(makePollRow({ expires_at: '2020-01-01T00:00:00Z' }));
    expect(poll.expired).toBe(true);
  });

  it('handles null expires_at', () => {
    const poll = serializePoll(makePollRow({ expires_at: null }));
    expect(poll.expired).toBe(false);
    expect(poll.expires_at).toBeNull();
  });

  it('converts multiple from 0/1 to boolean', () => {
    expect(serializePoll(makePollRow({ multiple: 0 })).multiple).toBe(false);
    expect(serializePoll(makePollRow({ multiple: 1 })).multiple).toBe(true);
  });

  it('includes voted and own_votes when provided', () => {
    const poll = serializePoll(makePollRow(), { voted: true, ownVotes: [0, 1] });
    expect(poll.voted).toBe(true);
    expect(poll.own_votes).toEqual([0, 1]);
  });

  it('defaults voted and own_votes to null', () => {
    const poll = serializePoll(makePollRow());
    expect(poll.voted).toBeNull();
    expect(poll.own_votes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeNotification
// ---------------------------------------------------------------------------
describe('serializeNotification', () => {
  it('converts a notification row to API format', () => {
    const account = serializeAccount(makeAccountRow());
    const row: NotificationRow = {
      id: 'notif-1',
      account_id: 'acct-1',
      from_account_id: 'acct-2',
      type: 'follow',
      status_id: null,
      read: 0,
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const notif = serializeNotification(row, { account });
    expect(notif.id).toBe('notif-1');
    expect(notif.type).toBe('follow');
    expect(notif.created_at).toBe('2024-01-01T00:00:00.000Z');
    expect(notif.account).toBe(account);
    expect(notif.status).toBeUndefined();
  });

  it('includes status when provided', () => {
    const account = serializeAccount(makeAccountRow());
    const status = serializeStatus(makeStatusRow(), { account });
    const row: NotificationRow = {
      id: 'notif-2',
      account_id: 'acct-1',
      from_account_id: 'acct-2',
      type: 'mention',
      status_id: 'status-1',
      read: 0,
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const notif = serializeNotification(row, { account, status });
    expect(notif.status).toBe(status);
  });

  it('includes null status when explicitly passed', () => {
    const account = serializeAccount(makeAccountRow());
    const row: NotificationRow = {
      id: 'notif-3',
      account_id: 'acct-1',
      from_account_id: 'acct-2',
      type: 'favourite',
      status_id: 'status-1',
      read: 0,
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const notif = serializeNotification(row, { account, status: null });
    expect(notif.status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeMediaAttachment
// ---------------------------------------------------------------------------
describe('serializeMediaAttachment', () => {
  function makeMediaRow(overrides?: Partial<MediaAttachmentRow>): MediaAttachmentRow {
    return {
      id: 'media-1',
      status_id: 'status-1',
      account_id: 'acct-1',
      file_key: 'uploads/image.png',
      file_content_type: 'image/png',
      file_size: 1024,
      thumbnail_key: 'uploads/thumb.png',
      remote_url: null,
      description: 'A photo',
      blurhash: 'LEHV6nWB2yk8pyoJadR*.7kCMdnj',
      width: 800,
      height: 600,
      type: 'image',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('converts media row to API format', () => {
    const media = serializeMediaAttachment(makeMediaRow(), 'example.com');
    expect(media.id).toBe('media-1');
    expect(media.type).toBe('image');
    expect(media.url).toBe('https://example.com/media/uploads/image.png');
    expect(media.preview_url).toBe('https://example.com/media/uploads/thumb.png');
    expect(media.description).toBe('A photo');
    expect(media.blurhash).toBe('LEHV6nWB2yk8pyoJadR*.7kCMdnj');
  });

  it('includes meta with dimensions', () => {
    const media = serializeMediaAttachment(makeMediaRow());
    expect(media.meta).not.toBeNull();
    expect(media.meta!.original!.width).toBe(800);
    expect(media.meta!.original!.height).toBe(600);
  });

  it('returns null meta when dimensions are null', () => {
    const media = serializeMediaAttachment(makeMediaRow({ width: null, height: null }));
    expect(media.meta).toBeNull();
  });

  it('falls back preview_url to file_key when no thumbnail', () => {
    const media = serializeMediaAttachment(makeMediaRow({ thumbnail_key: null }), 'example.com');
    expect(media.preview_url).toBe('https://example.com/media/uploads/image.png');
  });
});

// ---------------------------------------------------------------------------
// serializeRelationship
// ---------------------------------------------------------------------------
describe('serializeRelationship', () => {
  it('converts relationship data to API format', () => {
    const rel = serializeRelationship({
      id: 'acct-2',
      following: true,
      followedBy: false,
      blocking: false,
      blockedBy: false,
      muting: false,
      mutingNotifications: false,
      requested: false,
      showingReblogs: true,
      notifying: false,
      domainBlocking: false,
      endorsed: false,
      note: '',
    });
    expect(rel.id).toBe('acct-2');
    expect(rel.following).toBe(true);
    expect(rel.followed_by).toBe(false);
    expect(rel.showing_reblogs).toBe(true);
    expect(rel.requested_by).toBe(false);
    expect(rel.languages).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeList
// ---------------------------------------------------------------------------
describe('serializeList', () => {
  it('converts list row to API format', () => {
    const row: ListRow = {
      id: 'list-1',
      account_id: 'acct-1',
      title: 'My List',
      replies_policy: 'list',
      exclusive: 0,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    const list = serializeList(row);
    expect(list.id).toBe('list-1');
    expect(list.title).toBe('My List');
    expect(list.replies_policy).toBe('list');
    expect(list.exclusive).toBe(false);
  });

  it('converts exclusive 1 to true', () => {
    const row: ListRow = {
      id: 'list-2',
      account_id: 'acct-1',
      title: 'Exclusive List',
      replies_policy: 'followed',
      exclusive: 1,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    expect(serializeList(row).exclusive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// serializeTag
// ---------------------------------------------------------------------------
describe('serializeTag', () => {
  it('converts tag row to API format', () => {
    const row: TagRow = {
      id: 'tag-1',
      name: 'fediverse',
      display_name: 'Fediverse',
      usable: 1,
      trendable: 1,
      listable: 1,
      last_status_at: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    const tag = serializeTag(row);
    expect(tag.name).toBe('fediverse');
    expect(tag.history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// serializeFilter
// ---------------------------------------------------------------------------
describe('serializeFilter', () => {
  it('converts filter row to API format', () => {
    const row: FilterRow = {
      id: 'filter-1',
      user_id: 'user-1',
      title: 'Bad Words',
      context: '["home","public"]',
      action: 'warn',
      expires_at: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    const filter = serializeFilter(row);
    expect(filter.id).toBe('filter-1');
    expect(filter.title).toBe('Bad Words');
    expect(filter.context).toEqual(['home', 'public']);
    expect(filter.filter_action).toBe('warn');
    expect(filter.expires_at).toBeNull();
    expect(filter.keywords).toEqual([]);
    expect(filter.statuses).toEqual([]);
  });

  it('includes keywords when provided', () => {
    const row: FilterRow = {
      id: 'filter-2',
      user_id: 'user-1',
      title: 'Test',
      context: '["home"]',
      action: 'hide',
      expires_at: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    const filter = serializeFilter(row, {
      keywords: [
        { id: 'kw-1', keyword: 'spam', whole_word: 1 },
        { id: 'kw-2', keyword: 'ad', whole_word: 0 },
      ],
    });
    expect(filter.keywords).toHaveLength(2);
    expect(filter.keywords[0].keyword).toBe('spam');
    expect(filter.keywords[0].whole_word).toBe(true);
    expect(filter.keywords[1].whole_word).toBe(false);
  });

  it('handles invalid JSON in context', () => {
    const row: FilterRow = {
      id: 'filter-3',
      user_id: 'user-1',
      title: 'Broken',
      context: 'not json',
      action: 'warn',
      expires_at: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    const filter = serializeFilter(row);
    expect(filter.context).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// serializeMarker
// ---------------------------------------------------------------------------
describe('serializeMarker', () => {
  it('converts marker row to API format', () => {
    const row: MarkerRow = {
      id: 'marker-1',
      user_id: 'user-1',
      timeline: 'home',
      last_read_id: 'status-99',
      version: 3,
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    const marker = serializeMarker(row);
    expect(marker.last_read_id).toBe('status-99');
    expect(marker.version).toBe(3);
    expect(marker.updated_at).toBe('2024-01-01T00:00:00.000Z');
  });
});
