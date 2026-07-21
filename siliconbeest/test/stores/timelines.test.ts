import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTimelinesStore } from '@/stores/timelines';
import { useStatusesStore } from '@/stores/statuses';
import type { Status } from '@/types/mastodon';

const soundMocks = vi.hoisted(() => ({
  playNewPostSound: vi.fn(),
}));

vi.mock('@/utils/newPostSound', () => soundMocks);

// Mock API calls
vi.mock('@/api/mastodon/timelines', () => ({
  getHomeTimeline: vi.fn(),
  getRecommendedTimeline: vi.fn(),
  getRecommendedTimelinePage: vi.fn(),
  getSocialTimeline: vi.fn(),
  getPublicTimeline: vi.fn(),
  getTagTimeline: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  parseLinkHeader: vi.fn(() => ({})),
}));

vi.mock('@/api/streaming', () => ({
  // Must be constructible (`new StreamingClient(...)`), so no arrow function
  StreamingClient: vi.fn(function (this: Record<string, unknown>) {
    this.connect = vi.fn();
    this.disconnect = vi.fn();
    this.isActive = vi.fn(() => true);
  }),
}));

describe('Timelines Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('getTimeline', () => {
    it('creates empty timeline on first access', () => {
      const store = useTimelinesStore();
      const timeline = store.getTimeline('home');
      expect(timeline.statusIds).toEqual([]);
      expect(timeline.loading).toBe(false);
      expect(timeline.hasMore).toBe(true);
      expect(timeline.error).toBeNull();
      expect(timeline.newStatusIds).toEqual([]);
    });

    it('returns same timeline on repeated access', () => {
      const store = useTimelinesStore();
      const first = store.getTimeline('home');
      first.statusIds.push('1');
      const second = store.getTimeline('home');
      expect(second.statusIds).toEqual(['1']);
    });

    it('uses tag key for tag timelines', () => {
      const store = useTimelinesStore();
      const tagTimeline = store.getTimeline('tag', 'rust');
      tagTimeline.statusIds.push('100');
      // Different tag should create separate timeline
      const otherTag = store.getTimeline('tag', 'vue');
      expect(otherTag.statusIds).toEqual([]);
      // Original tag timeline should be intact
      expect(store.getTimeline('tag', 'rust').statusIds).toEqual(['100']);
    });
  });

  describe('recommended timeline', () => {
    it('follows the opaque Link cursor without deriving a max_id', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      const { parseLinkHeader } = await import('@/api/client');
      const firstPage = {
        data: [{ id: 'ranked-1', account: { id: 'author-1' }, reblog: null }],
        headers: { get: () => 'first-link' },
      } as never;
      const secondPage = {
        data: [{ id: 'ranked-2', account: { id: 'author-2' }, reblog: null }],
        headers: { get: () => null },
      } as never;
      const nextPage = '/api/v1/timelines/recommended?cursor=opaque%2Bcursor&limit=20';
      vi.mocked(timelineApi.getRecommendedTimeline).mockResolvedValue(firstPage);
      vi.mocked(timelineApi.getRecommendedTimelinePage).mockResolvedValue(secondPage);
      vi.mocked(parseLinkHeader)
        .mockReturnValueOnce({ next: nextPage })
        .mockReturnValueOnce({});

      const store = useTimelinesStore();
      await store.fetchTimeline('recommended', { token: 'token' });
      await store.fetchMore('recommended', { token: 'token' });

      expect(timelineApi.getRecommendedTimeline).toHaveBeenCalledWith({
        token: 'token',
      });
      expect(timelineApi.getRecommendedTimelinePage).toHaveBeenCalledWith(
        nextPage,
        'token',
        expect.anything(),
      );
      expect(store.getTimeline('recommended').statusIds).toEqual(['ranked-1', 'ranked-2']);
      expect(store.getTimeline('recommended').hasMore).toBe(false);
      expect(store.streamingClients.size).toBe(0);
    });

    it('stops retrying when an opaque recommendation cursor fails', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      vi.mocked(timelineApi.getRecommendedTimelinePage)
        .mockRejectedValue(new Error('recommendation snapshot expired'));

      const store = useTimelinesStore();
      const timeline = store.getTimeline('recommended');
      timeline.nextPage = '/api/v1/timelines/recommended?cursor=expired';
      timeline.hasMore = true;

      await store.fetchMore('recommended', { token: 'token' });

      expect(timeline.error).toBe('recommendation snapshot expired');
      expect(timeline.hasMore).toBe(false);
      expect(timeline.nextPage).toBeUndefined();
      expect(timeline.loadingMore).toBe(false);

      await store.fetchMore('recommended', { token: 'token' });
      expect(timelineApi.getRecommendedTimelinePage).toHaveBeenCalledOnce();
    });

    it('uses an API error description as the recommendation failure reason', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      vi.mocked(timelineApi.getRecommendedTimeline).mockRejectedValue(
        Object.assign(new Error('AI recommendation could not be generated'), {
          description: 'HTTP 429\ncode: 3040\nCapacity temporarily exceeded, please try again.',
        }),
      );

      const store = useTimelinesStore();
      await store.fetchTimeline('recommended', { token: 'token' });

      expect(store.getTimeline('recommended').error).toBe(
        'HTTP 429\ncode: 3040\nCapacity temporarily exceeded, please try again.',
      );
    });

    it('clears the old snapshot and requests a newly generated one', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      vi.mocked(timelineApi.getRecommendedTimeline).mockResolvedValue({
        data: [{ id: 'fresh-1', account: { id: 'author-1' }, reblog: null }],
        headers: { get: () => null },
      } as never);

      const store = useTimelinesStore();
      const timeline = store.getTimeline('recommended');
      timeline.statusIds = ['stale-1'];
      timeline.nextPage = '/api/v1/timelines/recommended?cursor=stale';
      timeline.error = 'old failure';

      await store.refreshRecommendedTimeline('token');

      expect(timelineApi.getRecommendedTimeline).toHaveBeenCalledWith({
        token: 'token',
      });
      expect(timeline.statusIds).toEqual(['fresh-1']);
      expect(timeline.nextPage).toBeUndefined();
      expect(timeline.error).toBeNull();
    });

    it('does not append an old cursor page after a fresh snapshot starts', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      let resolveOldPage: ((value: unknown) => void) | undefined;
      const oldPage = new Promise((resolve) => { resolveOldPage = resolve; });
      vi.mocked(timelineApi.getRecommendedTimelinePage).mockReturnValue(oldPage as never);
      vi.mocked(timelineApi.getRecommendedTimeline).mockResolvedValue({
        data: [{ id: 'fresh-only', account: { id: 'fresh-author' }, reblog: null }],
        headers: { get: () => null },
      } as never);

      const store = useTimelinesStore();
      const timeline = store.getTimeline('recommended');
      timeline.statusIds = ['old-first-page'];
      timeline.nextPage = '/api/v1/timelines/recommended?cursor=old-snapshot';
      timeline.hasMore = true;

      const pendingOldPage = store.fetchMore('recommended', { token: 'token' });
      await Promise.resolve();
      await store.refreshRecommendedTimeline('token');
      resolveOldPage?.({
        data: [{ id: 'old-second-page', account: { id: 'old-author' }, reblog: null }],
        headers: { get: () => null },
      });
      await pendingOldPage;

      expect(timeline.statusIds).toEqual(['fresh-only']);
      expect(timeline.loadingMore).toBe(false);
    });

    it('clears loadingMore when an initial request supersedes a cursor request', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      let resolveOldPage: ((value: unknown) => void) | undefined;
      const oldPage = new Promise((resolve) => { resolveOldPage = resolve; });
      vi.mocked(timelineApi.getRecommendedTimelinePage).mockReturnValue(oldPage as never);
      vi.mocked(timelineApi.getRecommendedTimeline).mockResolvedValue({
        data: [{ id: 'replacement', account: { id: 'author' }, reblog: null }],
        headers: { get: () => null },
      } as never);

      const store = useTimelinesStore();
      const timeline = store.getTimeline('recommended');
      timeline.nextPage = '/api/v1/timelines/recommended?cursor=old';
      const pendingOldPage = store.fetchMore('recommended', { token: 'token' });
      await Promise.resolve();
      expect(timeline.loadingMore).toBe(true);

      await store.fetchTimeline('recommended', { token: 'token' });
      expect(timeline.loadingMore).toBe(false);
      resolveOldPage?.({ data: [], headers: { get: () => null } });
      await pendingOldPage;
      expect(timeline.loadingMore).toBe(false);
      expect(timeline.statusIds).toEqual(['replacement']);
    });

    it('does not apply an account A response after reset and an account B request', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      let resolveAccountA: ((value: unknown) => void) | undefined;
      let resolveAccountB: ((value: unknown) => void) | undefined;
      const accountAResponse = new Promise((resolve) => { resolveAccountA = resolve; });
      const accountBResponse = new Promise((resolve) => { resolveAccountB = resolve; });
      vi.mocked(timelineApi.getRecommendedTimeline)
        .mockReturnValueOnce(accountAResponse as never)
        .mockReturnValueOnce(accountBResponse as never);

      const store = useTimelinesStore();
      const statuses = useStatusesStore();
      const accountATimeline = store.getTimeline('recommended');
      accountATimeline.statusIds = ['account-a-existing'];
      accountATimeline.nextPage = '/api/v1/timelines/recommended?cursor=account-a';
      const accountARequest = store.fetchTimeline('recommended', { token: 'account-a-token' });
      await Promise.resolve();

      store.reset();
      expect(accountATimeline.statusIds).toEqual([]);
      expect(accountATimeline.nextPage).toBeUndefined();
      expect(accountATimeline.loading).toBe(false);
      expect(store.timelines.size).toBe(0);

      const accountBRequest = store.fetchTimeline('recommended', { token: 'account-b-token' });
      const accountBTimeline = store.getTimeline('recommended');
      resolveAccountA?.({
        data: [{ id: 'account-a-private', account: { id: 'account-a' }, reblog: null }],
        headers: { get: () => null },
      });
      await accountARequest;

      expect(accountBTimeline.statusIds).toEqual([]);
      expect(accountBTimeline.loading).toBe(true);
      expect(statuses.cache.has('account-a-private')).toBe(false);

      resolveAccountB?.({
        data: [{ id: 'account-b-private', account: { id: 'account-b' }, reblog: null }],
        headers: { get: () => null },
      });
      await accountBRequest;

      expect(accountBTimeline.statusIds).toEqual(['account-b-private']);
      expect(accountBTimeline.loading).toBe(false);
      expect(statuses.cache.has('account-b-private')).toBe(true);
    });

    it('ignores a queued event from a stream disconnected by reset', async () => {
      const { StreamingClient } = await import('@/api/streaming');
      const store = useTimelinesStore();
      store.connectStream('account-a-token', 'user', 'home');
      const callbacks = vi.mocked(StreamingClient).mock.calls.at(-1)![2] as {
        onUpdate: (status: Status) => void;
      };

      store.reset();
      callbacks.onUpdate({
        id: 'account-a-private-stream-event',
        account: { id: 'account-a' },
      } as Status);

      expect(store.streamingClients.size).toBe(0);
      expect(store.timelines.has('home')).toBe(false);
      expect(useStatusesStore().cache.has('account-a-private-stream-event')).toBe(false);
    });
  });

  describe('next-page prefetch', () => {
    it('loads one page ahead without exposing it and reuses it on scroll', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      const { parseLinkHeader } = await import('@/api/client');
      let resolveNextPage: ((value: unknown) => void) | undefined;
      const nextPage = new Promise((resolve) => { resolveNextPage = resolve; });
      vi.mocked(timelineApi.getHomeTimeline)
        .mockResolvedValueOnce({
          data: [{ id: 'home-first', account: { id: 'author-1' }, reblog: null }],
          headers: { get: () => 'home-first-link' },
        } as never)
        .mockReturnValueOnce(nextPage as never);
      vi.mocked(parseLinkHeader).mockImplementation((header) => (
        header === 'home-first-link'
          ? { next: '/api/v1/timelines/home?max_id=home-first&limit=20' }
          : {}
      ));

      const store = useTimelinesStore();
      const statuses = useStatusesStore();
      await store.fetchTimeline('home', { token: 'token' });

      expect(timelineApi.getHomeTimeline).toHaveBeenCalledTimes(2);
      expect(timelineApi.getHomeTimeline).toHaveBeenLastCalledWith(expect.objectContaining({
        max_id: 'home-first',
        signal: expect.anything(),
        token: 'token',
      }));
      expect(store.getTimeline('home').statusIds).toEqual(['home-first']);
      expect(store.getTimeline('home').loadingMore).toBe(false);
      expect(statuses.cache.has('home-next')).toBe(false);

      const loadMore = store.fetchMore('home', { token: 'token' });
      await Promise.resolve();
      expect(timelineApi.getHomeTimeline).toHaveBeenCalledTimes(2);

      resolveNextPage?.({
        data: [{ id: 'home-next', account: { id: 'author-2' }, reblog: null }],
        headers: { get: () => null },
      });
      await loadMore;

      expect(store.getTimeline('home').statusIds).toEqual(['home-first', 'home-next']);
      expect(statuses.cache.has('home-next')).toBe(true);
    });

    it('keeps an in-flight recommended AI prefetch and appends it when scrolling reaches the end', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      const { parseLinkHeader } = await import('@/api/client');
      let resolveRecommendedPage: ((value: unknown) => void) | undefined;
      const recommendedPage = new Promise((resolve) => { resolveRecommendedPage = resolve; });
      const cursor = '/api/v1/timelines/recommended?cursor=in-flight&limit=30';
      vi.mocked(timelineApi.getRecommendedTimeline).mockResolvedValue({
        data: [{ id: 'recommended-first', account: { id: 'author-1' }, reblog: null }],
        headers: { get: () => 'recommended-first-link' },
      } as never);
      vi.mocked(timelineApi.getRecommendedTimelinePage).mockReturnValue(recommendedPage as never);
      vi.mocked(parseLinkHeader).mockImplementation((header) => (
        header === 'recommended-first-link' ? { next: cursor } : {}
      ));

      const store = useTimelinesStore();
      await store.fetchTimeline('recommended', { token: 'token' });

      expect(timelineApi.getRecommendedTimelinePage).toHaveBeenCalledOnce();
      const prefetchSignal = vi.mocked(timelineApi.getRecommendedTimelinePage).mock.calls[0]![2]!;
      expect(prefetchSignal.aborted).toBe(false);

      const loadMore = store.fetchMore('recommended', { token: 'token' });
      await Promise.resolve();

      expect(store.getTimeline('recommended').loadingMore).toBe(true);
      expect(timelineApi.getRecommendedTimelinePage).toHaveBeenCalledOnce();
      expect(prefetchSignal.aborted).toBe(false);

      resolveRecommendedPage?.({
        data: [{ id: 'recommended-next', account: { id: 'author-2' }, reblog: null }],
        headers: { get: () => null },
      });
      await loadMore;

      expect(timelineApi.getRecommendedTimelinePage).toHaveBeenCalledOnce();
      expect(store.getTimeline('recommended').statusIds).toEqual([
        'recommended-first',
        'recommended-next',
      ]);
      expect(store.getTimeline('recommended').loadingMore).toBe(false);
    });

    it('keeps a background failure silent and retries when the page is requested', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      const { parseLinkHeader } = await import('@/api/client');
      vi.mocked(timelineApi.getHomeTimeline)
        .mockResolvedValueOnce({
          data: [{ id: 'first', account: { id: 'author-1' }, reblog: null }],
          headers: { get: () => 'first-link' },
        } as never)
        .mockRejectedValueOnce(new Error('prefetch network failure'))
        .mockResolvedValueOnce({
          data: [{ id: 'retried', account: { id: 'author-2' }, reblog: null }],
          headers: { get: () => null },
        } as never);
      vi.mocked(parseLinkHeader).mockImplementation((header) => (
        header === 'first-link'
          ? { next: '/api/v1/timelines/home?max_id=first&limit=20' }
          : {}
      ));

      const store = useTimelinesStore();
      await store.fetchTimeline('home', { token: 'token' });
      await Promise.resolve();

      expect(store.getTimeline('home').error).toBeNull();
      expect(store.getTimeline('home').hasMore).toBe(true);

      await store.fetchMore('home', { token: 'token' });

      expect(timelineApi.getHomeTimeline).toHaveBeenCalledTimes(3);
      expect(store.getTimeline('home').statusIds).toEqual(['first', 'retried']);
      expect(store.getTimeline('home').error).toBeNull();
    });

    it('replaces an in-flight fallback when its visible feed is mutated', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      const { parseLinkHeader } = await import('@/api/client');
      let resolveStaleFallback: ((value: unknown) => void) | undefined;
      let resolveFreshFallback: ((value: unknown) => void) | undefined;
      const staleFallback = new Promise((resolve) => { resolveStaleFallback = resolve; });
      const freshFallback = new Promise((resolve) => { resolveFreshFallback = resolve; });
      vi.mocked(timelineApi.getHomeTimeline)
        .mockResolvedValueOnce({
          data: [{ id: 'visible-deleted', account: { id: 'author-1' }, reblog: null }],
          headers: { get: () => 'first-link' },
        } as never)
        .mockRejectedValueOnce(new Error('background failed'))
        .mockReturnValueOnce(staleFallback as never)
        .mockReturnValueOnce(freshFallback as never);
      vi.mocked(parseLinkHeader).mockImplementation((header) => (
        header === 'first-link'
          ? { next: '/api/v1/timelines/home?max_id=visible-deleted&limit=20' }
          : {}
      ));

      const store = useTimelinesStore();
      await store.fetchTimeline('home', { token: 'token' });

      const loadMore = store.fetchMore('home', { token: 'token' });
      await vi.waitFor(() => {
        expect(timelineApi.getHomeTimeline).toHaveBeenCalledTimes(3);
      });
      const staleSignal = vi.mocked(timelineApi.getHomeTimeline).mock.calls[2]![0].signal!;

      store.removeStatus('visible-deleted');
      await vi.waitFor(() => {
        expect(timelineApi.getHomeTimeline).toHaveBeenCalledTimes(4);
      });
      expect(staleSignal.aborted).toBe(true);

      resolveStaleFallback?.({
        data: [{ id: 'visible-deleted', account: { id: 'author-1' }, reblog: null }],
        headers: { get: () => null },
      });
      resolveFreshFallback?.({
        data: [{ id: 'fresh-next', account: { id: 'author-2' }, reblog: null }],
        headers: { get: () => null },
      });
      await loadMore;

      expect(store.getTimeline('home').statusIds).toEqual(['fresh-next']);
      expect(store.getTimeline('home').statusIds).not.toContain('visible-deleted');
    });

    it('refetches only a prefetched feed whose raw response contains a deleted status', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      const { parseLinkHeader } = await import('@/api/client');
      vi.mocked(timelineApi.getHomeTimeline)
        .mockResolvedValueOnce({
          data: [{ id: 'home-visible', account: { id: 'home-author' }, reblog: null }],
          headers: { get: () => 'home-link' },
        } as never)
        .mockResolvedValueOnce({
          data: [{ id: 'deleted-next', account: { id: 'deleted-author' }, reblog: null }],
          headers: { get: () => null },
        } as never)
        .mockResolvedValueOnce({
          data: [{ id: 'home-fresh-next', account: { id: 'fresh-author' }, reblog: null }],
          headers: { get: () => null },
        } as never);
      vi.mocked(timelineApi.getPublicTimeline)
        .mockResolvedValueOnce({
          data: [{ id: 'local-visible', account: { id: 'local-author' }, reblog: null }],
          headers: { get: () => 'local-link' },
        } as never)
        .mockResolvedValueOnce({
          data: [{ id: 'local-next', account: { id: 'other-author' }, reblog: null }],
          headers: { get: () => null },
        } as never);
      vi.mocked(parseLinkHeader).mockImplementation((header) => {
        if (header === 'home-link') {
          return { next: '/api/v1/timelines/home?max_id=home-visible&limit=20' };
        }
        if (header === 'local-link') {
          return { next: '/api/v1/timelines/public?max_id=local-visible&limit=20' };
        }
        return {};
      });

      const store = useTimelinesStore();
      await store.fetchTimeline('home', { token: 'token' });
      await store.fetchTimeline('local', { token: 'token' });
      await Promise.resolve();

      store.removeStatus('deleted-next');
      await vi.waitFor(() => {
        expect(timelineApi.getHomeTimeline).toHaveBeenCalledTimes(3);
      });

      expect(timelineApi.getPublicTimeline).toHaveBeenCalledTimes(2);
      await store.fetchMore('home', { token: 'token' });
      expect(store.getTimeline('home').statusIds).toEqual([
        'home-visible',
        'home-fresh-next',
      ]);
      expect(store.getTimeline('home').statusIds).not.toContain('deleted-next');
    });

    it('serializes a recommended replacement behind the in-flight AI page', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      const { parseLinkHeader } = await import('@/api/client');
      let resolveOldPrefetch: ((value: unknown) => void) | undefined;
      const oldPrefetch = new Promise((resolve) => { resolveOldPrefetch = resolve; });
      const cursor = '/api/v1/timelines/recommended?cursor=opaque&limit=30';
      vi.mocked(timelineApi.getRecommendedTimeline).mockResolvedValue({
        data: [{ id: 'recommended-visible', account: { id: 'author-1' }, reblog: null }],
        headers: { get: () => 'recommended-link' },
      } as never);
      vi.mocked(timelineApi.getRecommendedTimelinePage)
        .mockReturnValueOnce(oldPrefetch as never)
        .mockResolvedValueOnce({
          data: [{ id: 'recommended-fresh', account: { id: 'author-2' }, reblog: null }],
          headers: { get: () => null },
        } as never);
      vi.mocked(parseLinkHeader).mockImplementation((header) => (
        header === 'recommended-link' ? { next: cursor } : {}
      ));

      const store = useTimelinesStore();
      await store.fetchTimeline('recommended', { token: 'token' });
      store.removeStatus('recommended-visible');
      await Promise.resolve();

      expect(timelineApi.getRecommendedTimelinePage).toHaveBeenCalledOnce();

      resolveOldPrefetch?.({
        data: [{ id: 'old-page', account: { id: 'old-author' }, reblog: null }],
        headers: { get: () => null },
      });
      await vi.waitFor(() => {
        expect(timelineApi.getRecommendedTimelinePage).toHaveBeenCalledTimes(2);
      });

      expect(timelineApi.getRecommendedTimelinePage).toHaveBeenLastCalledWith(
        cursor,
        'token',
        expect.anything(),
      );
      await store.fetchMore('recommended', { token: 'token' });
      expect(store.getTimeline('recommended').statusIds).toEqual(['recommended-fresh']);
    });

    it('aborts and forgets a prefetched page when account state resets', async () => {
      const timelineApi = await import('@/api/mastodon/timelines');
      const { parseLinkHeader } = await import('@/api/client');
      let resolvePrivatePage: ((value: unknown) => void) | undefined;
      const privatePage = new Promise((resolve) => { resolvePrivatePage = resolve; });
      vi.mocked(timelineApi.getHomeTimeline)
        .mockResolvedValueOnce({
          data: [{ id: 'account-a-visible', account: { id: 'account-a' }, reblog: null }],
          headers: { get: () => 'account-a-link' },
        } as never)
        .mockReturnValueOnce(privatePage as never);
      vi.mocked(parseLinkHeader).mockImplementation((header) => (
        header === 'account-a-link'
          ? { next: '/api/v1/timelines/home?max_id=account-a-visible&limit=20' }
          : {}
      ));

      const store = useTimelinesStore();
      const statuses = useStatusesStore();
      await store.fetchTimeline('home', { token: 'account-a-token' });
      const prefetchSignal = vi.mocked(timelineApi.getHomeTimeline).mock.calls[1]![0].signal!;

      store.reset();
      expect(prefetchSignal.aborted).toBe(true);

      resolvePrivatePage?.({
        data: [{ id: 'account-a-private', account: { id: 'account-a' }, reblog: null }],
        headers: { get: () => null },
      });
      await Promise.resolve();

      expect(store.timelines.size).toBe(0);
      expect(statuses.cache.has('account-a-private')).toBe(false);
    });
  });

  describe('prependStatus', () => {
    it('adds status id to newStatusIds', () => {
      const store = useTimelinesStore();
      store.prependStatus('home', '42');
      const timeline = store.getTimeline('home');
      expect(timeline.newStatusIds).toContain('42');
    });

    it('prepends at beginning of newStatusIds', () => {
      const store = useTimelinesStore();
      store.prependStatus('home', '1');
      store.prependStatus('home', '2');
      const timeline = store.getTimeline('home');
      expect(timeline.newStatusIds[0]).toBe('2');
      expect(timeline.newStatusIds[1]).toBe('1');
    });
  });

  describe('showNewStatuses', () => {
    it('moves newStatusIds into statusIds', () => {
      const store = useTimelinesStore();
      const timeline = store.getTimeline('home');
      timeline.statusIds = ['old-1', 'old-2'];
      store.prependStatus('home', 'new-1');
      store.prependStatus('home', 'new-2');
      store.showNewStatuses('home');
      expect(timeline.statusIds[0]).toBe('new-2');
      expect(timeline.statusIds[1]).toBe('new-1');
      expect(timeline.statusIds[2]).toBe('old-1');
      expect(timeline.newStatusIds).toEqual([]);
    });
  });

  describe('removeStatus', () => {
    it('removes statusId from all timelines', () => {
      const store = useTimelinesStore();
      const home = store.getTimeline('home');
      const local = store.getTimeline('local');
      home.statusIds = ['1', '2', '3'];
      local.statusIds = ['2', '4'];
      store.removeStatus('2');
      expect(home.statusIds).toEqual(['1', '3']);
      expect(local.statusIds).toEqual(['4']);
    });

    it('also removes from newStatusIds', () => {
      const store = useTimelinesStore();
      store.prependStatus('home', '5');
      store.prependStatus('home', '6');
      store.removeStatus('5');
      const timeline = store.getTimeline('home');
      expect(timeline.newStatusIds).toEqual(['6']);
    });

    it('also removes a rendered reblog wrapper when its original is deleted', () => {
      const store = useTimelinesStore();
      const statuses = useStatusesStore();
      statuses.cacheStatus({
        id: 'wrapper',
        account: { id: 'booster' },
        reblog: { id: 'original', account: { id: 'author' } },
      } as Status);
      store.getTimeline('home').statusIds = ['wrapper', 'original', 'other'];

      store.removeStatus('original');

      expect(store.getTimeline('home').statusIds).toEqual(['other']);
    });

    it('removes direct and reblogged statuses after blocking or muting an account', () => {
      const store = useTimelinesStore();
      const statuses = useStatusesStore();
      statuses.cacheStatus({ id: 'direct', account: { id: 'hidden' }, reblog: null } as Status);
      statuses.cacheStatus({
        id: 'wrapper',
        account: { id: 'booster' },
        reblog: { id: 'original', account: { id: 'hidden' } },
      } as Status);
      statuses.cacheStatus({ id: 'kept', account: { id: 'visible' }, reblog: null } as Status);
      store.getTimeline('home').statusIds = ['direct', 'wrapper', 'kept'];

      store.removeAccountStatuses('hidden');

      expect(store.getTimeline('home').statusIds).toEqual(['kept']);
    });
  });

  describe('LIVE toggle (pauseStream/resumeStream)', () => {
    it('pauseStream disconnects and blocks reconnection', () => {
      const store = useTimelinesStore();
      store.connectStream('token', 'public:local', 'local');
      expect(store.streamingClients.has('public:local')).toBe(true);

      store.pauseStream('public:local');
      expect(store.isStreamPaused('public:local')).toBe(true);
      expect(store.streamingClients.has('public:local')).toBe(false);

      // While paused, connectStream (e.g. from a background fetch) is a no-op
      store.connectStream('token', 'public:local', 'local');
      expect(store.streamingClients.has('public:local')).toBe(false);
    });

    it('resumeStream refetches the timeline to fill the gap, then reconnects', async () => {
      const { getPublicTimeline } = await import('@/api/mastodon/timelines');
      vi.mocked(getPublicTimeline).mockResolvedValue({
        data: [],
        headers: { get: () => null },
      } as never);

      const store = useTimelinesStore();
      store.pauseStream('public:local');
      expect(store.isStreamPaused('public:local')).toBe(true);

      await store.resumeStream('public:local', 'local', { token: 'token' });

      expect(store.isStreamPaused('public:local')).toBe(false);
      expect(getPublicTimeline).toHaveBeenCalled();
      expect(store.streamingClients.has('public:local')).toBe(true);
    });

    it('pausing one stream leaves other streams connected', () => {
      const store = useTimelinesStore();
      store.connectStream('token', 'user', 'home');
      store.connectStream('token', 'public', 'public');

      store.pauseStream('public');
      expect(store.streamingClients.has('user')).toBe(true);
      expect(store.streamingClients.has('public')).toBe(false);
    });
  });

  describe('social timeline live fan-in', () => {
    it('queues home-stream updates into social when the social timeline is open', async () => {
      const { StreamingClient } = await import('@/api/streaming');
      const store = useTimelinesStore();
      store.getTimeline('social'); // the social column is open

      store.connectStream('token', 'user', 'home');
      const callbacks = vi.mocked(StreamingClient).mock.calls.at(-1)![2] as {
        onUpdate: (s: unknown) => void;
      };
      callbacks.onUpdate({ id: 'live-1', account: { id: 'acct-1' } });

      expect(store.getTimeline('home').newStatusIds).toContain('live-1');
      expect(store.getTimeline('social').newStatusIds).toContain('live-1');
    });

    it('does not create social queues when the social timeline is not open', async () => {
      const { StreamingClient } = await import('@/api/streaming');
      const store = useTimelinesStore();

      store.connectStream('token', 'public:local', 'local');
      const callbacks = vi.mocked(StreamingClient).mock.calls.at(-1)![2] as {
        onUpdate: (s: unknown) => void;
      };
      callbacks.onUpdate({ id: 'live-2', account: { id: 'acct-2' } });

      expect(store.getTimeline('local').newStatusIds).toContain('live-2');
      expect(store.timelines.has('social')).toBe(false);
    });
  });

  describe('new-post sound visibility', () => {
    async function emitUpdate(
      store: ReturnType<typeof useTimelinesStore>,
      stream: string,
      timelineType: 'home' | 'local' | 'public',
      statusId: string,
    ) {
      const { StreamingClient } = await import('@/api/streaming');
      const callIndex = vi.mocked(StreamingClient).mock.calls.length;
      store.connectStream('token', stream, timelineType);
      const callbacks = vi.mocked(StreamingClient).mock.calls[callIndex]![2] as {
        onUpdate: (s: unknown) => void;
      };
      callbacks.onUpdate({ id: statusId, account: { id: `acct-${statusId}` } });
    }

    it('stays silent when no view has registered an audible timeline', async () => {
      const store = useTimelinesStore();

      await emitUpdate(store, 'user', 'home', 'silent-home');

      expect(soundMocks.playNewPostSound).not.toHaveBeenCalled();
    });

    it('only plays updates whose source is in an audible scope', async () => {
      const store = useTimelinesStore();
      store.setAudibleTimelineScope('deck', ['home', 'public']);

      await emitUpdate(store, 'user', 'home', 'visible-home');
      await emitUpdate(store, 'public:local', 'local', 'hidden-local');
      await emitUpdate(store, 'public', 'public', 'visible-public');

      expect(soundMocks.playNewPostSound).toHaveBeenCalledTimes(2);
      expect(soundMocks.playNewPostSound).toHaveBeenNthCalledWith(1, 'visible-home');
      expect(soundMocks.playNewPostSound).toHaveBeenNthCalledWith(2, 'visible-public');
    });

    it('treats social as both home and local for live sound', async () => {
      const store = useTimelinesStore();
      store.setAudibleTimelineScope('mobile-deck', ['social']);

      await emitUpdate(store, 'user', 'home', 'social-home');
      await emitUpdate(store, 'public:local', 'local', 'social-local');
      await emitUpdate(store, 'public', 'public', 'not-social-public');

      expect(soundMocks.playNewPostSound).toHaveBeenCalledTimes(2);
      expect(soundMocks.playNewPostSound).toHaveBeenNthCalledWith(1, 'social-home');
      expect(soundMocks.playNewPostSound).toHaveBeenNthCalledWith(2, 'social-local');
    });

    it('combines owner scopes and clears only the specified owner', async () => {
      const store = useTimelinesStore();
      store.setAudibleTimelineScope('deck', ['home']);
      store.setAudibleTimelineScope('standalone', ['public']);

      store.clearAudibleTimelineScope('deck');
      await emitUpdate(store, 'user', 'home', 'cleared-home');
      await emitUpdate(store, 'public', 'public', 'remaining-public');

      expect(soundMocks.playNewPostSound).toHaveBeenCalledOnce();
      expect(soundMocks.playNewPostSound).toHaveBeenCalledWith('remaining-public');
    });

    it('keeps a newer instance audible when an older same-view instance cleans up', async () => {
      const store = useTimelinesStore();
      const oldDeckInstance = Symbol('deck-home');
      const newDeckInstance = Symbol('deck-home');

      store.setAudibleTimelineScope(oldDeckInstance, ['local']);
      store.setAudibleTimelineScope(newDeckInstance, ['public']);
      store.clearAudibleTimelineScope(oldDeckInstance);

      await emitUpdate(store, 'public:local', 'local', 'old-instance-local');
      await emitUpdate(store, 'public', 'public', 'new-instance-public');

      expect(soundMocks.playNewPostSound).toHaveBeenCalledOnce();
      expect(soundMocks.playNewPostSound).toHaveBeenCalledWith('new-instance-public');
    });

    it('replacing an owner scope with an empty list makes it silent', async () => {
      const store = useTimelinesStore();
      store.setAudibleTimelineScope('deck', ['home']);
      store.setAudibleTimelineScope('deck', []);

      await emitUpdate(store, 'user', 'home', 'empty-scope-home');

      expect(soundMocks.playNewPostSound).not.toHaveBeenCalled();
    });

    it('does not let a hidden delivery consume sound dedupe before a visible delivery', async () => {
      const store = useTimelinesStore();

      await emitUpdate(store, 'public:local', 'local', 'shared-status');
      store.setAudibleTimelineScope('mobile-deck', ['home']);
      await emitUpdate(store, 'user', 'home', 'shared-status');

      expect(soundMocks.playNewPostSound).toHaveBeenCalledOnce();
      expect(soundMocks.playNewPostSound).toHaveBeenCalledWith('shared-status');
    });
  });
});
