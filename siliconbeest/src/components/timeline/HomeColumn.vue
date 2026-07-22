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
import AnnouncementBanner from '@/components/common/AnnouncementBanner.vue'
import { useTimelineStreamViewport } from '@/composables/useTimelineStreamViewport'

const { t } = useI18n()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()
const ui = useUiStore()

withDefaults(defineProps<{
  /** Hide the column header (mobile deck provides its own tab strip). */
  hideHeader?: boolean
}>(), {
  hideHeader: false,
})

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
useTimelineStreamViewport('home-column', () => 'home', isAtTop)

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
      <header v-if="!hideHeader" class="sb-glass sticky top-0 z-10 flex flex-nowrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 class="sb-heading min-w-0 truncate text-lg">{{ t('nav.home') }}</h2>
        <button
          v-if="auth.isAuthenticated"
          @click="ui.openComposeModal()"
          class="sb-btn sb-btn-primary sb-btn-sm shrink-0 whitespace-nowrap"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
          </svg>
          {{ t('nav.compose') }}
        </button>
      </header>

      <AnnouncementBanner />

      <div v-if="timeline.error" class="mx-4 my-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-center text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
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
