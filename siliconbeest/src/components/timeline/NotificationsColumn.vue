<script setup lang="ts">
import { ref, computed, watch } from 'vue'
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

watch(
  () => auth.token,
  (token) => {
    if (token) void loadNotifications()
  },
  { immediate: true },
)
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto overscroll-contain">
    <!-- Notifications list view -->
    <template v-if="activeView === 'notifications'">
      <header class="sb-glass sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3">
        <h2 class="sb-heading text-lg">{{ t('nav.notifications') }}</h2>
        <button
          v-if="notificationsStore.unreadCount > 0"
          @click="markAllRead"
          class="sb-btn sb-btn-ghost sb-btn-sm text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
        >
          {{ t('notification.markAllRead') }}
        </button>
      </header>

      <div v-if="error" class="mx-4 my-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-center text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
        {{ error }}
      </div>

      <InfiniteScroll :loading="loading || loadingMore" :done="done" @load-more="loadMore">
        <NotificationItem
          v-for="notification in notifications"
          :key="notification.id"
          :notification="notification"
          @mark-read="handleMarkRead"
        />

        <div v-if="!loading && notifications.length === 0" class="sb-empty px-6">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-500 dark:bg-brand-950/50 dark:text-brand-300" aria-hidden="true">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
            </svg>
          </div>
          <p class="sb-heading text-lg text-slate-700 dark:text-slate-200">{{ t('notification.empty') }}</p>
          <p>{{ t('notification.empty_hint') }}</p>
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
