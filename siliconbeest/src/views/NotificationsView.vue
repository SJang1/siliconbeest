<script setup lang="ts">
import { ref, computed, watch } from 'vue'
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

watch(
  () => auth.token,
  (token) => {
    if (token) void loadNotifications()
  },
  { immediate: true },
)
</script>

<template>
  <AppShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 flex items-center justify-between gap-3 border-b px-4 py-3">
        <h1 class="sb-heading text-lg">{{ t('nav.notifications') }}</h1>
        <div class="flex items-center gap-1.5">
          <button
            v-if="notificationsStore.unreadCount > 0"
            @click="markAllRead"
            class="sb-btn sb-btn-sm text-brand-600 hover:bg-brand-50 active:scale-[0.98] dark:text-brand-400 dark:hover:bg-brand-950/50"
          >
            {{ t('notification.markAllRead') }}
          </button>
          <button
            v-if="notifications.length > 0"
            @click="clearAll"
            class="sb-btn sb-btn-sm text-slate-500 hover:bg-red-50 hover:text-red-600 active:scale-[0.98] dark:text-slate-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          >
            {{ t('notification.clearAll') }}
          </button>
        </div>
      </header>

      <div class="mx-auto w-full max-w-2xl">
        <!-- Follow requests banner -->
        <router-link
          v-if="followRequestCount > 0"
          to="/follow-requests"
          class="group mx-4 mt-3 flex items-center gap-3 rounded-2xl border border-brand-100 bg-brand-50/60 px-4 py-3 text-slate-900 no-underline transition-colors hover:bg-brand-100/70 dark:border-brand-900/50 dark:bg-brand-950/40 dark:text-slate-100 dark:hover:bg-brand-950/60"
        >
          <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface text-xl shadow-soft dark:bg-surface-dark">👋</span>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold">{{ t('notification.follow_requests_pending', { count: followRequestCount }) }}</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">{{ t('notification.follow_requests_hint') }}</p>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-5 w-5 shrink-0 text-brand-400 transition-transform group-hover:translate-x-0.5 dark:text-brand-500" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </router-link>

        <div v-if="error" class="px-4 py-3 text-center text-sm font-medium text-red-600 dark:text-red-400">
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
            <span class="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 dark:bg-surface-2-dark">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-6 w-6 text-slate-400 dark:text-slate-500" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.311 6.022c1.733.64 3.56 1.085 5.455 1.31m5.713 0a24.255 24.255 0 0 1-5.713 0m5.713 0a3 3 0 1 1-5.713 0" />
              </svg>
            </span>
            <div>
              <p class="text-base font-semibold text-slate-700 dark:text-slate-200">{{ t('notification.empty') }}</p>
              <p class="mt-1 text-sm">{{ t('notification.empty_hint') }}</p>
            </div>
          </div>
        </InfiniteScroll>
      </div>
    </div>
  </AppShell>
</template>
