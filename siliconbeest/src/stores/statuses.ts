import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Status } from '@/types/mastodon';
import {
  favouriteStatus,
  unfavouriteStatus,
  reblogStatus,
  unreblogStatus,
  bookmarkStatus,
  unbookmarkStatus,
  deleteStatus as apiDeleteStatus,
  editStatus as apiEditStatus,
} from '@/api/mastodon/statuses';
import type { CreateStatusParams } from '@/api/mastodon/statuses';
import { useAuthStore } from './auth';
import { useTimelinesStore } from './timelines';

export const useStatusesStore = defineStore('statuses', () => {
  // Covers six full 300-item timelines plus boost targets while remaining
  // finite under a high-rate public stream.
  const MAX_CACHED_STATUSES = 5_000;
  const cache = ref<Map<string, Status>>(new Map());

  // Bumped when a `reaction` stream event arrives for a status — components
  // rendering that status's reactions watch their entry and refetch.
  const reactionPings = ref<Map<string, number>>(new Map());

  function pingReaction(statusId: string) {
    const next = new Map(reactionPings.value);
    next.set(statusId, (next.get(statusId) ?? 0) + 1);
    reactionPings.value = next;
  }

  function cacheStatus(status: Status) {
    cache.value.delete(status.id);
    cache.value.set(status.id, status);
    if (status.reblog) {
      cache.value.delete(status.reblog.id);
      cache.value.set(status.reblog.id, status.reblog);
    }
    while (cache.value.size > MAX_CACHED_STATUSES) {
      const oldestId = cache.value.keys().next().value as string | undefined;
      if (!oldestId) break;
      cache.value.delete(oldestId);
      reactionPings.value.delete(oldestId);
    }
  }

  function cacheStatuses(statuses: Status[]) {
    for (const status of statuses) {
      cacheStatus(status);
    }
  }

  function getCached(id: string): Status | undefined {
    return cache.value.get(id);
  }

  // Optimistic update helper
  function updateCached(id: string, update: Partial<Status>) {
    const existing = cache.value.get(id);
    if (existing) {
      cache.value.set(id, { ...existing, ...update });
    }
  }

  async function toggleFavourite(status: Status) {
    const auth = useAuthStore();
    if (!auth.token) return;

    const targetId = status.reblog?.id ?? status.id;
    const target = cache.value.get(targetId) ?? status.reblog ?? status;
    const wasFavourited = target.favourited;

    // Optimistic update
    updateCached(targetId, {
      favourited: !wasFavourited,
      favourites_count: target.favourites_count + (wasFavourited ? -1 : 1),
    });

    try {
      const { data } = wasFavourited
        ? await unfavouriteStatus(targetId, auth.token)
        : await favouriteStatus(targetId, auth.token);
      cacheStatus(data);
    } catch {
      // Revert on error
      updateCached(targetId, {
        favourited: wasFavourited,
        favourites_count: target.favourites_count,
      });
    }
  }

  async function toggleReblog(status: Status) {
    const auth = useAuthStore();
    if (!auth.token) return;

    const targetId = status.reblog?.id ?? status.id;
    const target = cache.value.get(targetId) ?? status.reblog ?? status;
    const wasReblogged = target.reblogged;

    // Optimistic update
    updateCached(targetId, {
      reblogged: !wasReblogged,
      reblogs_count: target.reblogs_count + (wasReblogged ? -1 : 1),
    });

    try {
      const { data } = wasReblogged
        ? await unreblogStatus(targetId, auth.token)
        : await reblogStatus(targetId, auth.token);
      cacheStatus(data);
      // Add reblog to home timeline immediately
      if (!wasReblogged && data.id) {
        const timelinesStore = useTimelinesStore();
        const timeline = timelinesStore.getTimeline('home');
        if (!timeline.statusIds.includes(data.id)) {
          timeline.statusIds.unshift(data.id);
        }
      } else if (wasReblogged && data.id) {
        // Remove ONLY our boost wrapper from timelines — never the original
        // (the original may legitimately appear on local/federated feeds).
        // The unreblog API returns the ORIGINAL status, so find the wrapper
        // in the cache by its reblog target.
        const timelinesStore = useTimelinesStore();
        if (data.reblog?.id) {
          // Some responses return the wrapper itself — safe to remove
          timelinesStore.removeStatus(data.id);
        }
        const myAccountId = auth.currentUser?.id;
        for (const [id, cached] of cache.value) {
          if (id !== targetId && cached.reblog?.id === targetId && cached.account?.id === myAccountId) {
            timelinesStore.removeStatus(id);
          }
        }
      }
    } catch {
      // Revert on error
      updateCached(targetId, {
        reblogged: wasReblogged,
        reblogs_count: target.reblogs_count,
      });
    }
  }

  async function toggleBookmark(status: Status) {
    const auth = useAuthStore();
    if (!auth.token) return;

    const targetId = status.reblog?.id ?? status.id;
    const target = cache.value.get(targetId) ?? status.reblog ?? status;
    const wasBookmarked = target.bookmarked;

    // Optimistic update
    updateCached(targetId, { bookmarked: !wasBookmarked });

    try {
      const { data } = wasBookmarked
        ? await unbookmarkStatus(targetId, auth.token)
        : await bookmarkStatus(targetId, auth.token);
      cacheStatus(data);
    } catch {
      // Revert on error
      updateCached(targetId, { bookmarked: wasBookmarked });
    }
  }

  async function deleteStatus(id: string): Promise<string[]> {
    const auth = useAuthStore();
    if (!auth.token) return [];

    const removedIds = [id];
    for (const [cachedId, cachedStatus] of cache.value) {
      if (cachedId !== id && cachedStatus.reblog?.id === id) {
        removedIds.push(cachedId);
      }
    }

    await apiDeleteStatus(id, auth.token);
    for (const removedId of removedIds) cache.value.delete(removedId);
    return removedIds;
  }

  async function editStatus(id: string, params: CreateStatusParams) {
    const auth = useAuthStore();
    if (!auth.token) return;

    const { data } = await apiEditStatus(id, params, auth.token);
    cacheStatus(data);
    return data;
  }

  return {
    cache,
    reactionPings,
    pingReaction,
    cacheStatus,
    cacheStatuses,
    getCached,
    updateCached,
    toggleFavourite,
    toggleReblog,
    toggleBookmark,
    deleteStatus,
    editStatus,
  };
});
