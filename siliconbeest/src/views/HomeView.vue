<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import { useUiStore, type ColumnType } from '@/stores/ui'
import type { Status } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'
import TimelineColumn from '@/components/timeline/TimelineColumn.vue'
import NotificationsColumn from '@/components/timeline/NotificationsColumn.vue'
import AnnouncementBanner from '@/components/common/AnnouncementBanner.vue'
import ThreadView from '@/components/timeline/ThreadView.vue'

const { t } = useI18n()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()
const ui = useUiStore()

const columns = computed(() => ui.columns)

// Home column view stack
const homeView = ref<'timeline' | 'thread'>('timeline')
const homeThreadId = ref<string | null>(null)

function openHomeThread(status: Status) {
  homeThreadId.value = status.id
  homeView.value = 'thread'
}

function backToHomeTimeline() {
  homeView.value = 'timeline'
  homeThreadId.value = null
}

const timeline = computed(() => timelinesStore.getTimeline('home'))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})

const hasNewPosts = computed(() => timeline.value.newStatusIds.length > 0)

const homeColumnRef = ref<HTMLElement | null>(null)
const isAtTop = ref(true)
let scrollTimer: ReturnType<typeof setTimeout> | null = null

function handleScroll() {
  if (scrollTimer) return
  scrollTimer = setTimeout(() => {
    const el = homeColumnRef.value
    isAtTop.value = el ? el.scrollTop < 50 : window.scrollY < 50
    scrollTimer = null
  }, 100)
}

onMounted(() => {
  // Scroll listener will be attached after DOM renders via ref
})
onUnmounted(() => {
  if (scrollTimer) clearTimeout(scrollTimer)
})

watch(() => timeline.value.newStatusIds.length, (len) => {
  if (len > 0 && isAtTop.value) {
    timelinesStore.showNewStatuses('home')
  }
})

watch(isAtTop, (atTop) => {
  if (atTop && timeline.value.newStatusIds.length > 0) {
    timelinesStore.showNewStatuses('home')
  }
})

async function loadTimeline() {
  if (!auth.token) return
  await timelinesStore.fetchTimeline('home', { token: auth.token })
}

async function loadMore() {
  if (!auth.token) return
  await timelinesStore.fetchMore('home', { token: auth.token })
}

function showNew() {
  timelinesStore.showNewStatuses('home')
}

function getColumnTitle(type: ColumnType): string {
  const map: Record<ColumnType, string> = {
    local: t('nav.local_timeline'),
    federated: t('nav.federated_timeline'),
    notifications: t('nav.notifications'),
  }
  return map[type]
}

function getTimelineType(type: ColumnType): 'local' | 'public' {
  return type === 'federated' ? 'public' : 'local'
}

function getBannerKey(type: ColumnType): string {
  return `siliconbeest_banner_dismissed_${type}`
}

function getBannerText(type: ColumnType): string {
  const map: Record<string, string> = {
    local: t('timeline.local_banner'),
    federated: t('timeline.federated_banner'),
  }
  return map[type] || ''
}

onMounted(loadTimeline)
</script>

<template>
  <AppShell>
    <div
      class="grid h-full"
      :class="{
        'xl:grid-cols-2': columns.length >= 1,
        '2xl:grid-cols-3': columns.length >= 2,
      }"
    >
      <!-- Home Timeline (always visible) -->
      <div ref="homeColumnRef" class="border-r border-gray-200 dark:border-gray-700 h-full overflow-y-auto" @scroll="handleScroll">
        <template v-if="homeView === 'timeline'">
          <!-- Header -->
          <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between">
            <h2 class="text-lg font-bold">{{ t('nav.home') }}</h2>
            <button
              v-if="auth.isAuthenticated"
              @click="ui.openComposeModal()"
              class="px-3 py-1 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm transition-colors"
            >
              {{ t('nav.compose') }}
            </button>
          </header>

          <!-- Announcements -->
          <AnnouncementBanner />

          <!-- Error -->
          <div v-if="timeline.error" class="p-4 text-center text-red-500">
            {{ timeline.error }}
          </div>

          <!-- Feed -->
          <TimelineFeed
            :statuses="statuses"
            :loading="timeline.loading || timeline.loadingMore"
            :done="!timeline.hasMore"
            :has-new-posts="hasNewPosts && !isAtTop"
            :new-posts-count="timeline.newStatusIds.length"
            @load-more="loadMore"
            @load-new="showNew"
            @navigate="openHomeThread"
          />
        </template>

        <ThreadView
          v-else-if="homeThreadId"
          :status-id="homeThreadId"
          @back="backToHomeTimeline"
          @navigate="openHomeThread"
        />
      </div>

      <!-- First extra column (xl+) -->
      <div
        v-if="columns.length >= 1"
        class="hidden xl:block border-r border-gray-200 dark:border-gray-700 h-full overflow-y-auto"
      >
        <NotificationsColumn v-if="columns[0] === 'notifications'" />
        <TimelineColumn
          v-else
          :timeline-type="getTimelineType(columns[0]!)"
          :title="getColumnTitle(columns[0]!)"
          :banner-storage-key="getBannerKey(columns[0]!)"
          :banner-text="getBannerText(columns[0]!)"
        />
      </div>

      <!-- Second extra column (2xl+) -->
      <div
        v-if="columns.length >= 2"
        class="hidden 2xl:block h-full overflow-y-auto"
      >
        <NotificationsColumn v-if="columns[1] === 'notifications'" />
        <TimelineColumn
          v-else
          :timeline-type="getTimelineType(columns[1]!)"
          :title="getColumnTitle(columns[1]!)"
          :banner-storage-key="getBannerKey(columns[1]!)"
          :banner-text="getBannerText(columns[1]!)"
        />
      </div>
    </div>
  </AppShell>
</template>
