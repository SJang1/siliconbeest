import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Status } from '@/types/mastodon';
import { parseLinkHeader } from '@/api/client';
import {
  getHomeTimeline,
  getPublicTimeline,
  getTagTimeline,
} from '@/api/mastodon/timelines';
import { StreamingClient } from '@/api/streaming';
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
  // Multiple streaming connections — one per stream type
  const streamingClients = ref<Map<string, StreamingClient>>(new Map());
  // Cache for newly discovered remote custom emojis
  const emojiCache = ref<Map<string, { shortcode: string; url: string; static_url: string }> | null>(null);

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
        timeline.maxId = response.data[response.data.length - 1]!.id;
      }

      // Auto-connect streaming for each timeline type
      if (opts?.token) {
        const streamMap: Record<string, string> = {
          home: 'user',
          public: 'public',
          local: 'public:local',
        };
        const streamName = streamMap[type];
        if (streamName && !streamingClients.value.has(streamName)) {
          connectStream(opts.token, streamName, type);
        }
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
        timeline.maxId = response.data[response.data.length - 1]!.id;
      }
    } catch (e) {
      timeline.error = (e as Error).message;
    } finally {
      timeline.loadingMore = false;
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
    for (const timeline of timelines.value.values()) {
      timeline.statusIds = timeline.statusIds.filter((id) => id !== statusId);
      timeline.newStatusIds = timeline.newStatusIds.filter((id) => id !== statusId);
    }
  }

  function connectStream(token: string, stream: string = 'user', timelineType: TimelineType = 'home') {
    // Already connected to this stream
    if (streamingClients.value.has(stream)) return;

    const statusStore = useStatusesStore();
    const accountStore = useAccountsStore();

    const client = new StreamingClient(token, stream, {
      onUpdate(status: Status) {
        statusStore.cacheStatus(status);
        accountStore.cacheAccount(status.account);
        if (status.reblog) {
          accountStore.cacheAccount(status.reblog.account);
        }
        // Add to new status IDs queue for the correct timeline
        prependStatus(timelineType, status.id);
      },
      onDelete(statusId: string) {
        removeStatus(statusId);
      },
      onStatusUpdate(status: Status) {
        statusStore.cacheStatus(status);
        accountStore.cacheAccount(status.account);
        if (status.reblog) {
          accountStore.cacheAccount(status.reblog.account);
        }
      },
      onEmojiUpdate(emojis) {
        // Cache new emojis and re-render affected statuses
        if (!emojiCache.value) emojiCache.value = new Map();
        for (const emoji of emojis) {
          emojiCache.value.set(emoji.shortcode, emoji);
        }
        console.log(`[streaming] ${emojis.length} new emojis cached:`, emojis.map(e => `:${e.shortcode}:`).join(', '));
      },
    });

    streamingClients.value.set(stream, client);
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

  return {
    timelines,
    streamingClients,
    getTimeline,
    fetchTimeline,
    fetchMore,
    prependStatus,
    showNewStatuses,
    removeStatus,
    connectStream,
    disconnectStream,
  };
});
