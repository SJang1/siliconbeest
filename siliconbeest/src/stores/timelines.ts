import { defineStore } from 'pinia';
import { markRaw, ref } from 'vue';
import type { Status } from '@/types/mastodon';
import { parseLinkHeader, type ApiResponse } from '@/api/client';
import {
  getHomeTimeline,
  getRecommendedTimeline,
  getRecommendedTimelinePage,
  getSocialTimeline,
  getPublicTimeline,
  getTagTimeline,
} from '@/api/mastodon/timelines';
import { StreamingClient } from '@/api/streaming';
import { refreshAffectedStatusPagePrefetches } from '@/composables/useStatusPagePrefetch';
import { playNewPostSound } from '@/utils/newPostSound';
import { useStatusesStore } from './statuses';
import { useAccountsStore } from './accounts';
import {
  refreshNotificationsForRemovedAccount,
  refreshNotificationsForRemovedStatuses,
} from './notificationPrefetchInvalidation';

export type TimelineType = 'home' | 'recommended' | 'social' | 'public' | 'local' | 'tag';
export type AudibleTimelineScopeOwner = string | symbol;

type TimelineFetchOptions = { tag?: string; token?: string };

type TimelinePageCursor = {
  identity: string;
  maxId?: string;
  nextPage?: string;
};

type TimelinePagePrefetchResult =
  | { ok: true; response: ApiResponse<Status[]> }
  | { ok: false; error: unknown };

type PrefetchStatusPredicate = (status: Status) => boolean;

interface TimelinePagePrefetch {
  type: TimelineType;
  opts: TimelineFetchOptions;
  cursor: TimelinePageCursor;
  requestGeneration: number;
  lifecycleGeneration: number;
  controller: AbortController;
  expiresAt: number;
  invalidators: PrefetchStatusPredicate[];
  refreshAfterSettle: boolean;
  promise: Promise<TimelinePagePrefetchResult>;
}

// Recommended cursors expire after five minutes on the server. Keeping every
// look-ahead page below that window also bounds memory for abandoned tag feeds.
const TIMELINE_PREFETCH_TTL_MS = 4 * 60 * 1000;
const MAX_TIMELINE_PREFETCHES = 24;

interface TimelineState {
  statusIds: string[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  maxId?: string;
  nextPage?: string;
  error: string | null;
  newStatusIds: string[];
}

function createEmptyTimeline(): TimelineState {
  return {
    statusIds: [],
    loading: false,
    loadingMore: false,
    hasMore: true,
    maxId: undefined,
    nextPage: undefined,
    error: null,
    newStatusIds: [],
  };
}

function getTimelineErrorReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const description = Reflect.get(error, 'description');
    if (typeof description === 'string' && description.trim().length > 0) {
      return description.trim();
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return String(error);
}

export const useTimelinesStore = defineStore('timelines', () => {
  const timelines = ref<Map<string, TimelineState>>(new Map());
  // Initial loads supersede any older cursor request for the same feed. This
  // prevents an old recommendation snapshot from being appended after refresh.
  const requestGenerations = new Map<string, number>();
  // Unlike the per-feed generations, this value never resets. Account changes
  // can therefore invalidate an old request even when the next account starts
  // the same feed at generation 1 again.
  let lifecycleGeneration = 0;
  // Raw next-page responses live here until infinite scroll consumes them.
  // They deliberately do not populate status/account caches or timeline state.
  const pagePrefetches = new Map<string, TimelinePagePrefetch>();
  const queuedPrefetchRestarts = new Map<string, TimelinePagePrefetch>();
  let prefetchRestartQueued = false;
  // Multiple streaming connections — one per stream type
  const streamingClients = ref<Map<string, StreamingClient>>(new Map());
  // Streams the user toggled off (LIVE toggle) — connectStream respects this
  const pausedStreams = ref<Set<string>>(new Set());
  // Timeline views register which feeds are currently visible. Scopes are
  // owner-based so overlapping page transitions cannot clear another view's
  // sound policy. With no registered timelines, live updates stay silent.
  const audibleTimelineScopes = new Map<AudibleTimelineScopeOwner, Set<TimelineType>>();
  // Cache for newly discovered remote custom emojis
  const emojiCache = ref<Map<string, { shortcode: string; url: string; static_url: string }> | null>(null);

  function setAudibleTimelineScope(
    owner: AudibleTimelineScopeOwner,
    types: readonly TimelineType[],
  ) {
    audibleTimelineScopes.set(owner, new Set(types));
  }

  function clearAudibleTimelineScope(owner: AudibleTimelineScopeOwner) {
    audibleTimelineScopes.delete(owner);
  }

  function isTimelineAudible(sourceType: TimelineType): boolean {
    for (const types of audibleTimelineScopes.values()) {
      if (types.has(sourceType)) return true;
      // The social feed is a union of the home and local streams.
      if ((sourceType === 'home' || sourceType === 'local') && types.has('social')) {
        return true;
      }
    }
    return false;
  }

  function getTimelineKey(type: TimelineType, tag?: string): string {
    return type === 'tag' ? `tag:${tag}` : type;
  }

  function getTimeline(type: TimelineType, tag?: string): TimelineState {
    const key = getTimelineKey(type, tag);
    if (!timelines.value.has(key)) {
      timelines.value.set(key, createEmptyTimeline());
    }
    return timelines.value.get(key)!;
  }

  function isCurrentRequest(
    key: string,
    requestGeneration: number,
    requestLifecycleGeneration: number,
  ): boolean {
    return lifecycleGeneration === requestLifecycleGeneration
      && (requestGenerations.get(key) ?? 0) === requestGeneration;
  }

  function getNextPageCursor(
    type: TimelineType,
    timeline: TimelineState,
  ): TimelinePageCursor | null {
    if (!timeline.hasMore) return null;

    if (type === 'recommended') {
      return timeline.nextPage
        ? { identity: `next:${timeline.nextPage}`, nextPage: timeline.nextPage }
        : null;
    }

    return timeline.maxId
      ? { identity: `max:${timeline.maxId}`, maxId: timeline.maxId }
      : null;
  }

  async function requestTimelinePage(
    type: TimelineType,
    opts: TimelineFetchOptions,
    cursor: TimelinePageCursor,
    signal?: AbortSignal,
  ): Promise<ApiResponse<Status[]>> {
    const paginationOpts = {
      max_id: cursor.maxId,
      token: opts.token,
      signal,
    };

    switch (type) {
      case 'home':
        return getHomeTimeline({ ...paginationOpts, token: opts.token! });
      case 'recommended':
        return getRecommendedTimelinePage(cursor.nextPage!, opts.token!, signal);
      case 'social':
        return getSocialTimeline({ ...paginationOpts, token: opts.token! });
      case 'public':
        return getPublicTimeline(paginationOpts);
      case 'local':
        return getPublicTimeline({ ...paginationOpts, local: true });
      case 'tag':
        return getTagTimeline(opts.tag!, paginationOpts);
    }
  }

  function removePagePrefetch(key: string, abort: boolean) {
    const entry = pagePrefetches.get(key);
    if (!entry) return;
    pagePrefetches.delete(key);
    if (abort) entry.controller.abort();
  }

  function clearPagePrefetches() {
    for (const entry of pagePrefetches.values()) {
      entry.controller.abort();
    }
    pagePrefetches.clear();
    queuedPrefetchRestarts.clear();
  }

  function cleanupPagePrefetches(now: number) {
    for (const [key, entry] of pagePrefetches) {
      if (entry.expiresAt <= now) removePagePrefetch(key, true);
    }

    while (pagePrefetches.size >= MAX_TIMELINE_PREFETCHES) {
      const oldestKey = pagePrefetches.keys().next().value as string | undefined;
      if (!oldestKey) break;
      removePagePrefetch(oldestKey, true);
    }
  }

  function isMatchingPrefetch(
    entry: TimelinePagePrefetch,
    cursor: TimelinePageCursor,
    requestGeneration: number,
    requestLifecycleGeneration: number,
    token?: string,
  ): boolean {
    return entry.cursor.identity === cursor.identity
      && entry.requestGeneration === requestGeneration
      && entry.lifecycleGeneration === requestLifecycleGeneration
      && entry.opts.token === token
      && entry.expiresAt > Date.now();
  }

  function startPagePrefetch(
    type: TimelineType,
    opts: TimelineFetchOptions,
    force = false,
  ) {
    const key = getTimelineKey(type, opts.tag);
    const timeline = getTimeline(type, opts.tag);
    const cursor = getNextPageCursor(type, timeline);
    if (!cursor) {
      removePagePrefetch(key, true);
      return;
    }

    const requestGeneration = requestGenerations.get(key) ?? 0;
    const requestLifecycleGeneration = lifecycleGeneration;
    const existing = pagePrefetches.get(key);
    if (
      !force
      && existing
      && isMatchingPrefetch(
        existing,
        cursor,
        requestGeneration,
        requestLifecycleGeneration,
        opts.token,
      )
    ) return;

    removePagePrefetch(key, true);
    cleanupPagePrefetches(Date.now());

    const controller = new AbortController();
    const stableOpts = { tag: opts.tag, token: opts.token };
    const promise = requestTimelinePage(type, stableOpts, cursor, controller.signal).then(
      (response): TimelinePagePrefetchResult => ({ ok: true, response }),
      (error): TimelinePagePrefetchResult => ({ ok: false, error }),
    );
    pagePrefetches.set(key, {
      type,
      opts: stableOpts,
      cursor,
      requestGeneration,
      lifecycleGeneration: requestLifecycleGeneration,
      controller,
      expiresAt: Date.now() + TIMELINE_PREFETCH_TTL_MS,
      invalidators: [],
      refreshAfterSettle: false,
      promise,
    });
  }

  function restartPagePrefetch(key: string, expected?: TimelinePagePrefetch) {
    const entry = pagePrefetches.get(key);
    if (!entry || (expected && entry !== expected)) return;
    const { type, opts } = entry;
    startPagePrefetch(type, opts, true);
  }

  function queuePagePrefetchRestart(key: string, entry: TimelinePagePrefetch) {
    queuedPrefetchRestarts.set(key, entry);
    if (prefetchRestartQueued) return;
    prefetchRestartQueued = true;
    queueMicrotask(() => {
      prefetchRestartQueued = false;
      const restarts = [...queuedPrefetchRestarts];
      queuedPrefetchRestarts.clear();
      for (const [queuedKey, queuedEntry] of restarts) {
        restartPagePrefetch(queuedKey, queuedEntry);
      }
    });
  }

  function responseMatchesInvalidator(entry: TimelinePagePrefetch, statuses: Status[]) {
    return entry.invalidators.some((predicate) => statuses.some(predicate));
  }

  async function consumePagePrefetch(
    type: TimelineType,
    opts: TimelineFetchOptions,
    cursor: TimelinePageCursor,
    requestGeneration: number,
    requestLifecycleGeneration: number,
    retryAfterPrefetchFailure?: boolean,
  ): Promise<ApiResponse<Status[]> | undefined> {
    const key = getTimelineKey(type, opts.tag);
    if (!isCurrentRequest(key, requestGeneration, requestLifecycleGeneration)) {
      return undefined;
    }

    let entry = pagePrefetches.get(key);
    if (!entry) {
      // Keep even a user-triggered fallback in the same tracked slot as a
      // look-ahead request. A concurrent delete/block/mute can then replace
      // this response before it is allowed to enter the visible timeline.
      startPagePrefetch(type, opts);
      entry = pagePrefetches.get(key);
      retryAfterPrefetchFailure = false;
      if (!entry) return undefined;
    } else if (retryAfterPrefetchFailure === undefined) {
      // Consume a matching in-flight prefetch in place. Replacing it here would
      // discard useful work and duplicate paid recommendation inference when
      // infinite scroll reaches the end before the AI page has settled.
      // An entry that existed before consume() is the speculative request. If
      // it failed silently, the actual scroll gets one normal tracked retry.
      retryAfterPrefetchFailure = true;
    }

    if (!isMatchingPrefetch(
      entry,
      cursor,
      requestGeneration,
      requestLifecycleGeneration,
      opts.token,
    )) {
      removePagePrefetch(key, true);
      startPagePrefetch(type, opts);
      return consumePagePrefetch(
        type,
        opts,
        cursor,
        requestGeneration,
        requestLifecycleGeneration,
        false,
      );
    }

    const result = await entry.promise;
    const currentEntry = pagePrefetches.get(key);
    if (currentEntry !== entry) {
      return consumePagePrefetch(
        type,
        opts,
        cursor,
        requestGeneration,
        requestLifecycleGeneration,
        retryAfterPrefetchFailure,
      );
    }
    if (!isCurrentRequest(key, requestGeneration, requestLifecycleGeneration)) {
      removePagePrefetch(key, true);
      return undefined;
    }
    if (!result.ok) {
      removePagePrefetch(key, false);
      if (retryAfterPrefetchFailure) {
        startPagePrefetch(type, opts);
        return consumePagePrefetch(
          type,
          opts,
          cursor,
          requestGeneration,
          requestLifecycleGeneration,
          false,
        );
      }
      throw result.error;
    }
    if (
      entry.refreshAfterSettle
      || responseMatchesInvalidator(entry, result.response.data)
    ) {
      restartPagePrefetch(key, entry);
      return consumePagePrefetch(
        type,
        opts,
        cursor,
        requestGeneration,
        requestLifecycleGeneration,
        retryAfterPrefetchFailure,
      );
    }

    removePagePrefetch(key, false);
    return result.response;
  }

  function refreshAffectedPagePrefetches(
    predicate: PrefetchStatusPredicate,
    immediatelyAffectedKeys: ReadonlySet<string>,
  ) {
    for (const [key, entry] of [...pagePrefetches]) {
      entry.invalidators.push(predicate);
      if (immediatelyAffectedKeys.has(key)) {
        entry.refreshAfterSettle = true;
        if (entry.type === 'recommended') {
          void entry.promise.then(() => queuePagePrefetchRestart(key, entry));
        } else {
          queuePagePrefetchRestart(key, entry);
        }
        continue;
      }

      void entry.promise.then((result) => {
        if (
          result.ok
          && pagePrefetches.get(key) === entry
          && responseMatchesInvalidator(entry, result.response.data)
        ) {
          queuePagePrefetchRestart(key, entry);
        }
      });
    }
  }

  function cacheStatusesFromResponse(statuses: Status[]) {
    const statusStore = useStatusesStore();
    const accountStore = useAccountsStore();

    for (const status of statuses) {
      statusStore.cacheStatus(status);
      accountStore.cacheAccount(status.account);
      if (status.reblog) {
        accountStore.cacheAccount(status.reblog.account);
      }
    }
  }

  async function fetchTimeline(
    type: TimelineType,
    opts?: TimelineFetchOptions,
  ) {
    const key = getTimelineKey(type, opts?.tag);
    const timeline = getTimeline(type, opts?.tag);
    if (timeline.loading) return;
    const requestGeneration = (requestGenerations.get(key) ?? 0) + 1;
    requestGenerations.set(key, requestGeneration);
    const requestLifecycleGeneration = lifecycleGeneration;
    removePagePrefetch(key, true);
    // The new initial request supersedes any cursor request already in flight.
    // Clear its flag here because the stale request's finally block must not
    // mutate state owned by this generation.
    timeline.loadingMore = false;
    timeline.loading = true;
    timeline.error = null;

    try {
      let response;
      switch (type) {
        case 'home':
          response = await getHomeTimeline({ token: opts?.token! });
          break;
        case 'recommended':
          response = await getRecommendedTimeline({
            token: opts?.token!,
          });
          break;
        case 'social':
          response = await getSocialTimeline({ token: opts?.token! });
          break;
        case 'public':
          response = await getPublicTimeline({ token: opts?.token });
          break;
        case 'local':
          response = await getPublicTimeline({ local: true, token: opts?.token });
          break;
        case 'tag':
          response = await getTagTimeline(opts?.tag!, { token: opts?.token });
          break;
      }

      if (!isCurrentRequest(key, requestGeneration, requestLifecycleGeneration)) return;

      cacheStatusesFromResponse(response.data);
      timeline.statusIds = response.data.map((s) => s.id);

      const links = parseLinkHeader(response.headers.get('Link'));
      timeline.hasMore = !!links.next;
      timeline.nextPage = links.next;
      if (type !== 'recommended' && response.data.length > 0) {
        timeline.maxId = response.data[response.data.length - 1]!.id;
      }
      startPagePrefetch(type, opts ?? {});

      // Auto-connect streaming for each timeline type
      if (opts?.token) {
        if (type === 'social') {
          // Social merges home + local: live updates arrive on both streams
          // (onUpdate fans them into the social timeline as well)
          connectStream(opts.token, 'user', 'home');
          connectStream(opts.token, 'public:local', 'local');
        } else {
          const streamMap: Record<string, string> = {
            home: 'user',
            public: 'public',
            local: 'public:local',
          };
          const streamName = streamMap[type];
          if (streamName) {
            connectStream(opts.token, streamName, type);
          }
        }
      }
    } catch (e) {
      if (isCurrentRequest(key, requestGeneration, requestLifecycleGeneration)) {
        timeline.error = getTimelineErrorReason(e);
      }
    } finally {
      if (isCurrentRequest(key, requestGeneration, requestLifecycleGeneration)) {
        timeline.loading = false;
      }
    }
  }

  /** Clear cursor/results and ask the server for a newly generated recommendation snapshot. */
  async function refreshRecommendedTimeline(token: string) {
    const timeline = getTimeline('recommended');
    if (timeline.loading) return;
    Object.assign(timeline, createEmptyTimeline());
    await fetchTimeline('recommended', { token });
  }

  async function fetchMore(
    type: TimelineType,
    opts?: TimelineFetchOptions,
  ) {
    const key = getTimelineKey(type, opts?.tag);
    const timeline = getTimeline(type, opts?.tag);
    if (timeline.loadingMore || !timeline.hasMore) return;

    const cursor = getNextPageCursor(type, timeline);
    if (!cursor) {
      timeline.hasMore = false;
      return;
    }

    const requestGeneration = requestGenerations.get(key) ?? 0;
    const requestLifecycleGeneration = lifecycleGeneration;
    timeline.loadingMore = true;
    timeline.error = null;

    try {
      const stableOpts = opts ?? {};
      const response = await consumePagePrefetch(
        type,
        stableOpts,
        cursor,
        requestGeneration,
        requestLifecycleGeneration,
      );
      if (!response) return;

      if (!isCurrentRequest(key, requestGeneration, requestLifecycleGeneration)) return;

      cacheStatusesFromResponse(response.data);
      timeline.statusIds.push(...response.data.map((s) => s.id));

      const links = parseLinkHeader(response.headers.get('Link'));
      timeline.hasMore = !!links.next;
      timeline.nextPage = links.next;
      if (type !== 'recommended' && response.data.length > 0) {
        timeline.maxId = response.data[response.data.length - 1]!.id;
      }
      startPagePrefetch(type, stableOpts);
    } catch (e) {
      if (isCurrentRequest(key, requestGeneration, requestLifecycleGeneration)) {
        timeline.error = getTimelineErrorReason(e);
        // Recommendation pagination uses an opaque, server-owned snapshot.
        // Once that cursor is rejected it cannot be repaired client-side, so
        // stop automatic/infinite-scroll retries until a manual refresh starts
        // a new snapshot.
        if (type === 'recommended') {
          timeline.hasMore = false;
          timeline.nextPage = undefined;
        }
      }
    } finally {
      if (isCurrentRequest(key, requestGeneration, requestLifecycleGeneration)) {
        timeline.loadingMore = false;
      }
    }
  }

  function prependStatus(type: TimelineType, statusId: string, tag?: string) {
    const timeline = getTimeline(type, tag);
    // Deduplicate: skip if already in newStatusIds or statusIds
    if (timeline.newStatusIds.includes(statusId) || timeline.statusIds.includes(statusId)) return;
    timeline.newStatusIds.unshift(statusId);
  }

  function showNewStatuses(type: TimelineType, tag?: string) {
    const timeline = getTimeline(type, tag);
    const unique = timeline.newStatusIds.filter((id) => !timeline.statusIds.includes(id));
    timeline.statusIds.unshift(...unique);
    timeline.newStatusIds = [];
  }

  function removeStatus(statusId: string) {
    const statusStore = useStatusesStore();
    const removedIds = new Set([statusId]);
    for (const [cachedId, cachedStatus] of statusStore.cache) {
      if (cachedStatus.reblog?.id === statusId) removedIds.add(cachedId);
    }

    const affectedKeys = new Set<string>();
    for (const [key, timeline] of timelines.value) {
      const previousStatusCount = timeline.statusIds.length;
      const previousNewStatusCount = timeline.newStatusIds.length;
      timeline.statusIds = timeline.statusIds.filter((id) => !removedIds.has(id));
      timeline.newStatusIds = timeline.newStatusIds.filter((id) => !removedIds.has(id));
      if (
        timeline.statusIds.length !== previousStatusCount
        || timeline.newStatusIds.length !== previousNewStatusCount
      ) {
        affectedKeys.add(key);
      }
    }

    const affectsRemovedStatus = (status: Status) => (
      removedIds.has(status.id) || !!status.reblog && removedIds.has(status.reblog.id)
    );
    refreshAffectedPagePrefetches(affectsRemovedStatus, affectedKeys);
    refreshAffectedStatusPagePrefetches(affectsRemovedStatus);
    refreshNotificationsForRemovedStatuses(removedIds);
  }

  function removeAccountStatuses(accountId: string) {
    const statusStore = useStatusesStore();
    const removedIds = new Set<string>();
    for (const [cachedId, cachedStatus] of statusStore.cache) {
      if (
        cachedStatus.account.id === accountId
        || cachedStatus.reblog?.account.id === accountId
      ) {
        removedIds.add(cachedId);
      }
    }

    const affectedKeys = new Set<string>();
    for (const [key, timeline] of timelines.value) {
      const previousStatusCount = timeline.statusIds.length;
      const previousNewStatusCount = timeline.newStatusIds.length;
      timeline.statusIds = timeline.statusIds.filter((id) => !removedIds.has(id));
      timeline.newStatusIds = timeline.newStatusIds.filter((id) => !removedIds.has(id));
      if (
        timeline.statusIds.length !== previousStatusCount
        || timeline.newStatusIds.length !== previousNewStatusCount
      ) {
        affectedKeys.add(key);
      }
    }

    const belongsToRemovedAccount = (status: Status) => (
      status.account.id === accountId || status.reblog?.account.id === accountId
    );
    refreshAffectedPagePrefetches(belongsToRemovedAccount, affectedKeys);
    refreshAffectedStatusPagePrefetches(belongsToRemovedAccount);
    refreshNotificationsForRemovedAccount(accountId);
  }

  function isStreamPaused(stream: string): boolean {
    return pausedStreams.value.has(stream);
  }

  /** LIVE toggle off: remember the choice and close this feed's connection. */
  function pauseStream(stream: string) {
    pausedStreams.value = new Set([...pausedStreams.value, stream]);
    disconnectStream(stream);
  }

  /** Clear a stream's paused flag without fetching (multi-stream resumes). */
  function unpauseStream(stream: string) {
    pausedStreams.value = new Set([...pausedStreams.value].filter((s) => s !== stream));
  }

  /**
   * LIVE toggle on: refetch the timeline first so posts missed while paused
   * aren't silently skipped, then reconnect (fetchTimeline auto-connects
   * when a token is present).
   */
  async function resumeStream(
    stream: string,
    type: TimelineType,
    opts?: TimelineFetchOptions,
  ) {
    pausedStreams.value = new Set([...pausedStreams.value].filter((s) => s !== stream));
    await fetchTimeline(type, opts);
  }

  function connectStream(token: string, stream: string = 'user', timelineType: TimelineType = 'home') {
    if (typeof window === 'undefined') return;
    if (pausedStreams.value.has(stream)) return;

    const existingClient = streamingClients.value.get(stream);
    if (existingClient?.isActive()) return;
    if (existingClient) {
      existingClient.disconnect();
      streamingClients.value.delete(stream);
    }

    const statusStore = useStatusesStore();
    const accountStore = useAccountsStore();
    const streamLifecycleGeneration = lifecycleGeneration;

    const client = new StreamingClient(token, stream, {
      onUpdate(status: Status) {
        if (
          lifecycleGeneration !== streamLifecycleGeneration
          || streamingClients.value.get(stream) !== client
        ) return;

        statusStore.cacheStatus(status);
        accountStore.cacheAccount(status.account);
        if (status.reblog) {
          accountStore.cacheAccount(status.reblog.account);
        }
        // Add to new status IDs queue for the correct timeline
        prependStatus(timelineType, status.id);
        // The social timeline merges home + local — fan their live updates
        // in as well (prependStatus dedupes across streams)
        if ((timelineType === 'home' || timelineType === 'local') && timelines.value.has('social')) {
          prependStatus('social', status.id);
        }
        // Check visibility before the sound helper's status-id dedupe. A
        // hidden stream must not consume the id and silence a subsequent
        // delivery to a visible timeline.
        if (isTimelineAudible(timelineType)) {
          playNewPostSound(status.id);
        }
      },
      onDelete(statusId: string) {
        if (
          lifecycleGeneration !== streamLifecycleGeneration
          || streamingClients.value.get(stream) !== client
        ) return;

        removeStatus(statusId);
      },
      onStatusUpdate(status: Status) {
        if (
          lifecycleGeneration !== streamLifecycleGeneration
          || streamingClients.value.get(stream) !== client
        ) return;

        statusStore.cacheStatus(status);
        accountStore.cacheAccount(status.account);
        if (status.reblog) {
          accountStore.cacheAccount(status.reblog.account);
        }
      },
      onReaction(statusId: string) {
        if (
          lifecycleGeneration !== streamLifecycleGeneration
          || streamingClients.value.get(stream) !== client
        ) return;

        statusStore.pingReaction(statusId);
      },
      onEmojiUpdate(emojis) {
        if (
          lifecycleGeneration !== streamLifecycleGeneration
          || streamingClients.value.get(stream) !== client
        ) return;

        // Cache new emojis and re-render affected statuses
        if (!emojiCache.value) emojiCache.value = new Map();
        for (const emoji of emojis) {
          emojiCache.value.set(emoji.shortcode, emoji);
        }
        console.log(`[streaming] ${emojis.length} new emojis cached:`, emojis.map(e => `:${e.shortcode}:`).join(', '));
      },
    });

    streamingClients.value.set(stream, markRaw(client));
    client.connect();
  }

  function disconnectStream(stream?: string) {
    if (stream) {
      const client = streamingClients.value.get(stream);
      if (client) {
        client.disconnect();
        streamingClients.value.delete(stream);
      }
    } else {
      // Disconnect all streams
      for (const client of streamingClients.value.values()) {
        client.disconnect();
      }
      streamingClients.value.clear();
    }
  }

  /**
   * Drop every account-scoped timeline value and invalidate outstanding work.
   * Existing state objects are emptied before the map is replaced so mounted
   * consumers holding an old reference cannot keep rendering private results.
   */
  function reset() {
    lifecycleGeneration += 1;
    disconnectStream();
    clearPagePrefetches();

    for (const timeline of timelines.value.values()) {
      Object.assign(timeline, createEmptyTimeline());
    }
    timelines.value = new Map();
    requestGenerations.clear();
    pausedStreams.value = new Set();
    emojiCache.value = null;
  }

  return {
    timelines,
    streamingClients,
    pausedStreams,
    reset,
    getTimeline,
    fetchTimeline,
    refreshRecommendedTimeline,
    fetchMore,
    prependStatus,
    showNewStatuses,
    removeStatus,
    removeAccountStatuses,
    connectStream,
    disconnectStream,
    isStreamPaused,
    pauseStream,
    unpauseStream,
    resumeStream,
    setAudibleTimelineScope,
    clearAudibleTimelineScope,
  };
});
