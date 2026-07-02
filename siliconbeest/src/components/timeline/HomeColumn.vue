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

const hasNewPosts = computed(() => timeline.value.newStatusIds.length > 0)

const isAtTop = ref(true)

function handleScroll(event: Event) {
  isAtTop.value = (event.currentTarget as HTMLElement).scrollTop < 100
}

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

watch(
  () => auth.token,
  (token) => {
    if (token) void loadTimeline()
  },
  { immediate: true },
)
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto overscroll-contain" @scroll.passive="handleScroll">
    <template v-if="activeView === 'timeline'">
      <header class="sb-glass sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3">
        <h2 class="sb-heading text-lg">{{ t('nav.home') }}</h2>
        <button
          v-if="auth.isAuthenticated"
          @click="ui.openComposeModal()"
          class="sb-btn sb-btn-primary sb-btn-sm"
        >
          {{ t('nav.compose') }}
        </button>
      </header>

      <AnnouncementBanner />

      <div v-if="timeline.error" class="mx-4 my-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-center text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
        {{ timeline.error }}
      </div>

      <TimelineFeed
        :statuses="statuses"
        :loading="timeline.loading || timeline.loadingMore"
        :done="!timeline.hasMore"
        :has-new-posts="hasNewPosts && !isAtTop"
        :new-posts-count="timeline.newStatusIds.length"
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
