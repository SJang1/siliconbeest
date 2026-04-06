<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { useNotificationsStore } from '@/stores/notifications'
import { useAuthStore } from '@/stores/auth'
import NotificationItem from '@/components/notification/NotificationItem.vue'
import InfiniteScroll from '@/components/common/InfiniteScroll.vue'
import ThreadView from './ThreadView.vue'

const { t } = useI18n()
const notificationsStore = useNotificationsStore()
const auth = useAuthStore()

const notifications = computed(() => notificationsStore.items)
const loading = computed(() => notificationsStore.loading)
const loadingMore = computed(() => notificationsStore.loadingMore)
const done = computed(() => !notificationsStore.hasMore)
const error = computed(() => notificationsStore.error)

// View stack
const activeView = ref<'notifications' | 'thread'>('notifications')
const threadStatusId = ref<string | null>(null)

function openThread(status: Status) {
  threadStatusId.value = status.id
  activeView.value = 'thread'
}

function backToNotifications() {
  activeView.value = 'notifications'
  threadStatusId.value = null
}

async function loadNotifications() {
  if (!auth.token) return
  await notificationsStore.fetch(auth.token)
}

async function loadMore() {
  if (!auth.token) return
  await notificationsStore.fetchMore(auth.token)
}

async function markAllRead() {
  if (!auth.token) return
  await notificationsStore.markAllRead(auth.token)
  notifications.value.forEach((n: any) => { n.read = 1 })
}

async function handleMarkRead(id: string) {
  if (!auth.token) return
  await notificationsStore.markRead(id, auth.token)
  const notif = notifications.value.find(n => n.id === id) as any
  if (notif) notif.read = 1
}

onMounted(loadNotifications)
</script>

<template>
  <div>
    <!-- Notifications list view -->
    <template v-if="activeView === 'notifications'">
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between">
        <h2 class="text-lg font-bold">{{ t('nav.notifications') }}</h2>
        <button
          v-if="notificationsStore.unreadCount > 0"
          @click="markAllRead"
          class="text-sm text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
        >
          {{ t('notification.markAllRead') }}
        </button>
      </header>

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
    </template>

    <!-- Thread view -->
    <ThreadView
      v-else-if="threadStatusId"
      :status-id="threadStatusId"
      @back="backToNotifications"
      @navigate="openThread"
    />
  </div>
</template>
