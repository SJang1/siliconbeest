import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Notification } from '@/types/mastodon';
import {
  getNotifications as fetchNotifications,
  clearNotifications as apiClearNotifications,
  dismissNotification as apiDismissNotification,
} from '@/api/mastodon/notifications';
import { parseLinkHeader } from '@/api/client';
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

  const unreadCount = computed(() => {
    if (!lastReadId.value) return items.value.length;
    const idx = items.value.findIndex((n) => n.id === lastReadId.value);
    return idx === -1 ? items.value.length : idx;
  });

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
        maxId.value = data[data.length - 1].id;
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
        maxId.value = data[data.length - 1].id;
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

  function markAllRead() {
    if (items.value.length > 0) {
      lastReadId.value = items.value[0].id;
    }
  }

  function prepend(notification: Notification) {
    items.value.unshift(notification);
  }

  return {
    items,
    loading,
    loadingMore,
    hasMore,
    error,
    unreadCount,
    lastReadId,
    fetch,
    fetchMore,
    clearAll,
    dismiss,
    markAllRead,
    prepend,
  };
});
