import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Notification } from '@/types/mastodon';
import {
  getNotifications as fetchNotifications,
  clearNotifications as apiClearNotifications,
  dismissNotification as apiDismissNotification,
} from '@/api/mastodon/notifications';
import { parseLinkHeader, apiFetch } from '@/api/client';
import { StreamingClient } from '@/api/streaming';
import { useStatusesStore } from './statuses';
import { useAccountsStore } from './accounts';

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<Notification[]>([]);
  const loading = ref(false);
  const loadingMore = ref(false);
  const hasMore = ref(true);
  const maxId = ref<string>();
  const error = ref<string | null>(null);
  const lastReadId = ref<string | null>(null);
  const streamingClient = ref<StreamingClient | null>(null);
  const serverUnreadCount = ref(0);

  const unreadCount = computed(() => serverUnreadCount.value);

  function cacheFromNotifications(notifications: Notification[]) {
    const statusStore = useStatusesStore();
    const accountStore = useAccountsStore();

    for (const notification of notifications) {
      accountStore.cacheAccount(notification.account);
      if (notification.status) {
        statusStore.cacheStatus(notification.status);
        accountStore.cacheAccount(notification.status.account);
      }
    }
  }

  async function fetch(token: string) {
    loading.value = true;
    error.value = null;

    try {
      const { data, headers } = await fetchNotifications({ token });
      cacheFromNotifications(data);
      items.value = data;

      const links = parseLinkHeader(headers.get('Link'));
      hasMore.value = !!links.next;
      if (data.length > 0) {
        maxId.value = data[data.length - 1]!.id;
      }

      // Fetch unread count from server
      await fetchUnreadCount(token);

      // Auto-connect streaming for notifications
      if (!streamingClient.value) {
        connectStream(token);
      }
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchMore(token: string) {
    if (loadingMore.value || !hasMore.value) return;

    loadingMore.value = true;
    error.value = null;

    try {
      const { data, headers } = await fetchNotifications({
        token,
        max_id: maxId.value,
      });
      cacheFromNotifications(data);
      items.value.push(...data);

      const links = parseLinkHeader(headers.get('Link'));
      hasMore.value = !!links.next;
      if (data.length > 0) {
        maxId.value = data[data.length - 1]!.id;
      }
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loadingMore.value = false;
    }
  }

  async function clearAll(token: string) {
    await apiClearNotifications(token);
    items.value = [];
    lastReadId.value = items.value[0]?.id ?? null;
  }

  async function dismiss(id: string, token: string) {
    await apiDismissNotification(id, token);
    items.value = items.value.filter((n) => n.id !== id);
  }

  async function fetchUnreadCount(token: string) {
    try {
      const { data } = await apiFetch<{ count: number }>('/v1/notifications/unread_count', { token });
      serverUnreadCount.value = data.count;
    } catch { /* ignore */ }
  }

  async function markAllRead(token?: string) {
    if (!token) return;
    try {
      const { data } = await apiFetch<{ count: number }>('/v1/notifications/read', {
        method: 'POST',
        token,
        body: {},
      });
      serverUnreadCount.value = data.count;
    } catch { /* ignore */ }
  }

  async function markRead(id: string, token: string) {
    try {
      const { data } = await apiFetch<{ count: number }>('/v1/notifications/read', {
        method: 'POST',
        token,
        body: { id },
      });
      serverUnreadCount.value = data.count;
    } catch { /* ignore */ }
  }

  async function loadMarker(token: string) {
    await fetchUnreadCount(token);
  }

  function prepend(notification: Notification) {
    items.value.unshift(notification);
  }

  function connectStream(token: string) {
    disconnectStream();

    streamingClient.value = new StreamingClient(token, 'user:notification', {
      onNotification(notification: Notification) {
        try {
          cacheFromNotifications([notification]);
          // Deduplicate: don't add if already in list
          if (!items.value.some(n => n.id === notification.id)) {
            prepend(notification);
            serverUnreadCount.value++;
          }
        } catch (e) {
          console.error('[notifications streaming] Error processing notification:', e);
          // Still try to prepend even if caching fails
          if (!items.value.some(n => n.id === notification.id)) {
            prepend(notification);
            serverUnreadCount.value++;
          }
        }
      },
      onNotificationsRead(count: number) {
        serverUnreadCount.value = count;
        // Also update local read state for items that should now be read
        if (count === 0) {
          items.value.forEach((n: any) => { n.read = 1; });
        }
      },
    });

    streamingClient.value.connect();
  }

  function disconnectStream() {
    if (streamingClient.value) {
      streamingClient.value.disconnect();
      streamingClient.value = null;
    }
  }

  return {
    items,
    loading,
    loadingMore,
    hasMore,
    error,
    unreadCount,
    lastReadId,
    streamingClient,
    fetch,
    fetchMore,
    clearAll,
    dismiss,
    serverUnreadCount,
    markAllRead,
    markRead,
    fetchUnreadCount,
    loadMarker,
    prepend,
    connectStream,
    disconnectStream,
  };
});
