import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useStatusesStore } from '@/stores/statuses';
import type { Status } from '@/types/mastodon';

// Mock API calls
vi.mock('@/api/mastodon/statuses', () => ({
  favouriteStatus: vi.fn(),
  unfavouriteStatus: vi.fn(),
  reblogStatus: vi.fn(),
  unreblogStatus: vi.fn(),
  bookmarkStatus: vi.fn(),
  unbookmarkStatus: vi.fn(),
  deleteStatus: vi.fn(),
}));

function makeStatus(overrides: Partial<Status> = {}): Status {
  return {
    id: '1',
    created_at: '2026-01-01T00:00:00Z',
    content: '<p>Hello world</p>',
    visibility: 'public',
    favourited: false,
    reblogged: false,
    bookmarked: false,
    favourites_count: 0,
    reblogs_count: 0,
    replies_count: 0,
    sensitive: false,
    spoiler_text: '',
    uri: 'https://example.com/statuses/1',
    url: 'https://example.com/@user/1',
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    account: {
      id: 'a1',
      username: 'testuser',
      acct: 'testuser',
      display_name: 'Test User',
      url: 'https://example.com/@testuser',
      avatar: '',
      avatar_static: '',
      header: '',
      header_static: '',
      emojis: [],
      fields: [],
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      created_at: '2026-01-01T00:00:00Z',
      note: '',
    },
    ...overrides,
  } as Status;
}

describe('Statuses Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('cacheStatus', () => {
    it('adds a status to the cache', () => {
      const store = useStatusesStore();
      const status = makeStatus({ id: '42' });
      store.cacheStatus(status);
      expect(store.getCached('42')).toEqual(status);
    });

    it('also caches the reblog if present', () => {
      const store = useStatusesStore();
      const original = makeStatus({ id: '10' });
      const reblog = makeStatus({ id: '20', reblog: original });
      store.cacheStatus(reblog);
      expect(store.getCached('20')).toBeDefined();
      expect(store.getCached('10')).toBeDefined();
    });
  });

  describe('cacheStatuses', () => {
    it('caches multiple statuses', () => {
      const store = useStatusesStore();
      const s1 = makeStatus({ id: '1' });
      const s2 = makeStatus({ id: '2' });
      store.cacheStatuses([s1, s2]);
      expect(store.getCached('1')).toBeDefined();
      expect(store.getCached('2')).toBeDefined();
    });
  });

  describe('updateCached', () => {
    it('updates a cached status with partial data', () => {
      const store = useStatusesStore();
      const status = makeStatus({ id: '1', favourited: false, favourites_count: 0 });
      store.cacheStatus(status);
      store.updateCached('1', { favourited: true, favourites_count: 1 });
      const cached = store.getCached('1');
      expect(cached?.favourited).toBe(true);
      expect(cached?.favourites_count).toBe(1);
    });

    it('does nothing for a missing id', () => {
      const store = useStatusesStore();
      // Should not throw
      store.updateCached('nonexistent', { favourited: true });
      expect(store.getCached('nonexistent')).toBeUndefined();
    });
  });

  describe('optimistic favourite', () => {
    it('toggles favourited and count optimistically', () => {
      const store = useStatusesStore();
      const status = makeStatus({ id: '1', favourited: false, favourites_count: 5 });
      store.cacheStatus(status);
      store.updateCached('1', {
        favourited: true,
        favourites_count: 6,
      });
      const cached = store.getCached('1');
      expect(cached?.favourited).toBe(true);
      expect(cached?.favourites_count).toBe(6);
    });

    it('reverts favourite on error scenario', () => {
      const store = useStatusesStore();
      const status = makeStatus({ id: '1', favourited: false, favourites_count: 5 });
      store.cacheStatus(status);
      // Optimistic update
      store.updateCached('1', { favourited: true, favourites_count: 6 });
      // Revert
      store.updateCached('1', { favourited: false, favourites_count: 5 });
      const cached = store.getCached('1');
      expect(cached?.favourited).toBe(false);
      expect(cached?.favourites_count).toBe(5);
    });
  });

  describe('optimistic reblog', () => {
    it('toggles reblogged and count optimistically', () => {
      const store = useStatusesStore();
      const status = makeStatus({ id: '1', reblogged: false, reblogs_count: 3 });
      store.cacheStatus(status);
      store.updateCached('1', {
        reblogged: true,
        reblogs_count: 4,
      });
      const cached = store.getCached('1');
      expect(cached?.reblogged).toBe(true);
      expect(cached?.reblogs_count).toBe(4);
    });

    it('reverts reblog on error scenario', () => {
      const store = useStatusesStore();
      const status = makeStatus({ id: '1', reblogged: false, reblogs_count: 3 });
      store.cacheStatus(status);
      store.updateCached('1', { reblogged: true, reblogs_count: 4 });
      store.updateCached('1', { reblogged: false, reblogs_count: 3 });
      const cached = store.getCached('1');
      expect(cached?.reblogged).toBe(false);
      expect(cached?.reblogs_count).toBe(3);
    });
  });
});
