<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotificationsStore } from '@/stores/notifications'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'
import AppShell from '@/components/layout/AppShell.vue'
import NotificationItem from '@/components/notification/NotificationItem.vue'
import InfiniteScroll from '@/components/common/InfiniteScroll.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const notificationsStore = useNotificationsStore()
const auth = useAuthStore()

const notifications = computed(() => notificationsStore.items)
const loading = computed(() => notificationsStore.loading)
const loadingMore = computed(() => notificationsStore.loadingMore)
const done = computed(() => !notificationsStore.hasMore)
const error = computed(() => notificationsStore.error)

const followRequestCount = ref(0)

async function loadNotifications() {
  if (!auth.token) return
  await notificationsStore.fetch(auth.token)

  // Check follow requests
  try {
    const { data } = await apiFetch<any[]>('/v1/follow_requests', { token: auth.token })
    followRequestCount.value = data.length
  } catch { /* ignore */ }
}

async function loadMore() {
  if (!auth.token) return
  await notificationsStore.fetchMore(auth.token)
}

async function clearAll() {
  if (!auth.token) return
  await notificationsStore.clearAll(auth.token)
}

async function markAllRead() {
  if (!auth.token) return
  await notificationsStore.markAllRead(auth.token)
  // Update local read state for visual feedback
  notifications.value.forEach((n: any) => { n.read = 1 })
}

async function handleMarkRead(id: string) {
  if (!auth.token) return
  await notificationsStore.markRead(id, auth.token)
  // Update local read state
  const notif = notifications.value.find(n => n.id === id) as any
  if (notif) notif.read = 1
}

onMounted(loadNotifications)
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between">
        <h1 class="text-xl font-bold">{{ t('nav.notifications') }}</h1>
        <div class="flex items-center gap-3">
          <button
            v-if="notificationsStore.unreadCount > 0"
            @click="markAllRead"
            class="text-sm text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
          >
            {{ t('notification.markAllRead') }}
          </button>
          <button
            v-if="notifications.length > 0"
            @click="clearAll"
            class="text-sm text-gray-500 dark:text-gray-400 hover:text-red-500 transition-colors"
          >
            {{ t('notification.clearAll') }}
          </button>
        </div>
      </header>

      <!-- Follow requests banner -->
      <router-link
        v-if="followRequestCount > 0"
        to="/follow-requests"
        class="flex items-center gap-3 px-4 py-3 bg-indigo-50 dark:bg-indigo-950 border-b border-indigo-100 dark:border-indigo-900 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition-colors no-underline text-gray-900 dark:text-gray-100"
      >
        <span class="text-2xl">👋</span>
        <div class="flex-1">
          <p class="font-bold text-sm">{{ t('notification.follow_requests_pending', { count: followRequestCount }) }}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('notification.follow_requests_hint') }}</p>
        </div>
        <span class="text-gray-400">→</span>
      </router-link>

      <div v-if="error" class="p-4 text-center text-red-500">
        {{ error }}
      </div>

      <InfiniteScroll :loading="loading || loadingMore" :done="done" @load-more="loadMore">
        <NotificationItem
          v-for="notification in notifications"
          :key="notification.id"
          :notification="notification"
          @mark-read="handleMarkRead"
        />

        <div v-if="!loading && notifications.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
          <p class="text-lg font-medium">{{ t('notification.empty') }}</p>
          <p class="text-sm mt-1">{{ t('notification.empty_hint') }}</p>
        </div>
      </InfiniteScroll>
    </div>
  </AppShell>
</template>
