<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import type { Status } from '@/types/mastodon'
import TimelineFeed from './TimelineFeed.vue'
import ThreadView from './ThreadView.vue'
import AnnouncementBanner from '@/legacy/components/common/AnnouncementBanner.vue'
import { useTimelineStreamViewport } from '@/composables/useTimelineStreamViewport'

const { t } = useI18n()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()
const ui = useUiStore()

// View stack
const activeView = ref<'timeline' | 'thread'>('timeline')
const threadStatusId = ref<string | null>(null)

function openThread(status: Status) {
  threadStatusId.value = status.id
  activeView.value = 'thread'
}

function backToTimeline() {
  activeView.value = 'timeline'
  threadStatusId.value = null
}

const timeline = computed(() => timelinesStore.getTimeline('home'))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})

const newStatusCount = computed(() => timelinesStore.getNewStatusCount('home'))
const hasNewPosts = computed(() => newStatusCount.value > 0)

const isAtTop = ref(true)
useTimelineStreamViewport('legacy-home-column', () => 'home', isAtTop)

function handleScroll(event: Event) {
  isAtTop.value = (event.currentTarget as HTMLElement).scrollTop < 100
}

watch(newStatusCount, (len) => {
  if (len > 0 && isAtTop.value) {
    timelinesStore.showNewStatuses('home')
  }
})

watch(isAtTop, (atTop) => {
  if (atTop && newStatusCount.value > 0) {
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

watch(
  () => auth.token,
  (token) => {
    if (token) void loadTimeline()
  },
  { immediate: true },
)
</script>

<template>
  <div data-status-scroll class="h-full min-h-0 overflow-y-auto overscroll-contain" @scroll.passive="handleScroll">
    <template v-if="activeView === 'timeline'">
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

      <AnnouncementBanner />

      <div v-if="timeline.error" class="p-4 text-center text-red-500">
        {{ timeline.error }}
      </div>

      <TimelineFeed
        :statuses="statuses"
        timeline-key="home"
        show-advertisements
        :loading="timeline.loading || timeline.loadingMore"
        :done="!timeline.hasMore"
        :has-new-posts="hasNewPosts && !isAtTop"
        :new-posts-count="newStatusCount"
        @load-more="loadMore"
        @load-new="showNew"
        @navigate="openThread"
      />
    </template>

    <ThreadView
      v-else-if="threadStatusId"
      :status-id="threadStatusId"
      @back="backToTimeline"
      @navigate="openThread"
    />
  </div>
</template>
