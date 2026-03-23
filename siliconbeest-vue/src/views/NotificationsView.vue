<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Notification } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import NotificationItem from '@/components/notification/NotificationItem.vue'
import InfiniteScroll from '@/components/common/InfiniteScroll.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()

const notifications = ref<Notification[]>([])
const loading = ref(false)
const done = ref(false)

async function loadNotifications() {
  if (loading.value || done.value) return
  loading.value = true
  try {
    // TODO: fetch from API
  } finally {
    loading.value = false
  }
}

onMounted(loadNotifications)
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('nav.notifications') }}</h1>
      </header>

      <InfiniteScroll :loading="loading" :done="done" @load-more="loadNotifications">
        <NotificationItem
          v-for="notification in notifications"
          :key="notification.id"
          :notification="notification"
        />

        <div v-if="!loading && notifications.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
          <p class="text-lg font-medium">{{ t('notifications.empty') }}</p>
          <p class="text-sm mt-1">{{ t('notifications.empty_hint') }}</p>
        </div>
      </InfiniteScroll>
    </div>
  </AppShell>
</template>
