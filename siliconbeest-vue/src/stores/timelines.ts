import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Status } from '@/types/mastodon';
import { parseLinkHeader } from '@/api/client';
import {
  getHomeTimeline,
  getPublicTimeline,
  getTagTimeline,
} from '@/api/mastodon/timelines';
import { useStatusesStore } from './statuses';
import { useAccountsStore } from './accounts';

export type TimelineType = 'home' | 'public' | 'local' | 'tag';

interface TimelineState {
  statusIds: string[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  maxId?: string;
  error: string | null;
  newStatusIds: string[];
}

function createEmptyTimeline(): TimelineState {
  return {
    statusIds: [],
    loading: false,
    loadingMore: false,
    hasMore: true,
    error: null,
    newStatusIds: [],
  };
}

export const useTimelinesStore = defineStore('timelines', () => {
  const timelines = ref<Map<string, TimelineState>>(new Map());

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
    opts?: { tag?: string; token?: string },
  ) {
    const key = getTimelineKey(type, opts?.tag);
    const timeline = getTimeline(type, opts?.tag);
    timeline.loading = true;
    timeline.error = null;

    try {
      let response;
      switch (type) {
        case 'home':
          response = await getHomeTimeline({ token: opts?.token! });
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

      cacheStatusesFromResponse(response.data);
      timeline.statusIds = response.data.map((s) => s.id);

      const links = parseLinkHeader(response.headers.get('Link'));
      timeline.hasMore = !!links.next;
      if (response.data.length > 0) {
        timeline.maxId = response.data[response.data.length - 1].id;
      }
    } catch (e) {
      timeline.error = (e as Error).message;
    } finally {
      timeline.loading = false;
    }
  }

  async function fetchMore(
    type: TimelineType,
    opts?: { tag?: string; token?: string },
  ) {
    const timeline = getTimeline(type, opts?.tag);
    if (timeline.loadingMore || !timeline.hasMore) return;

    timeline.loadingMore = true;
    timeline.error = null;

    try {
      let response;
      const paginationOpts = { max_id: timeline.maxId, token: opts?.token };

      switch (type) {
        case 'home':
          response = await getHomeTimeline({ ...paginationOpts, token: opts?.token! });
          break;
        case 'public':
          response = await getPublicTimeline(paginationOpts);
          break;
        case 'local':
          response = await getPublicTimeline({ ...paginationOpts, local: true });
          break;
        case 'tag':
          response = await getTagTimeline(opts?.tag!, paginationOpts);
          break;
      }

      cacheStatusesFromResponse(response.data);
      timeline.statusIds.push(...response.data.map((s) => s.id));

      const links = parseLinkHeader(response.headers.get('Link'));
      timeline.hasMore = !!links.next;
      if (response.data.length > 0) {
        timeline.maxId = response.data[response.data.length - 1].id;
      }
    } catch (e) {
      timeline.error = (e as Error).message;
    } finally {
      timeline.loadingMore = false;
    }
  }

  function prependStatus(type: TimelineType, statusId: string, tag?: string) {
    const timeline = getTimeline(type, tag);
    timeline.newStatusIds.unshift(statusId);
  }

  function showNewStatuses(type: TimelineType, tag?: string) {
    const timeline = getTimeline(type, tag);
    timeline.statusIds.unshift(...timeline.newStatusIds);
    timeline.newStatusIds = [];
  }

  function removeStatus(statusId: string) {
    for (const timeline of timelines.value.values()) {
      timeline.statusIds = timeline.statusIds.filter((id) => id !== statusId);
      timeline.newStatusIds = timeline.newStatusIds.filter((id) => id !== statusId);
    }
  }

  return {
    timelines,
    getTimeline,
    fetchTimeline,
    fetchMore,
    prependStatus,
    showNewStatuses,
    removeStatus,
  };
});
