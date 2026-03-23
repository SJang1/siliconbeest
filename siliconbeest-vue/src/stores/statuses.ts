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
} from '@/api/mastodon/statuses';
import { useAuthStore } from './auth';

export const useStatusesStore = defineStore('statuses', () => {
  const cache = ref<Map<string, Status>>(new Map());

  function cacheStatus(status: Status) {
    cache.value.set(status.id, status);
    if (status.reblog) {
      cache.value.set(status.reblog.id, status.reblog);
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

  async function deleteStatus(id: string) {
    const auth = useAuthStore();
    if (!auth.token) return;

    await apiDeleteStatus(id, auth.token);
    cache.value.delete(id);
  }

  return {
    cache,
    cacheStatus,
    cacheStatuses,
    getCached,
    updateCached,
    toggleFavourite,
    toggleReblog,
    toggleBookmark,
    deleteStatus,
  };
});
