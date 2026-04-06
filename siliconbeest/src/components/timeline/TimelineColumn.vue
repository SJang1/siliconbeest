<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import type { TimelineType } from '@/stores/timelines'
import TimelineFeed from './TimelineFeed.vue'
import ThreadView from './ThreadView.vue'
import DismissibleBanner from '@/components/common/DismissibleBanner.vue'

const { t } = useI18n()

const props = defineProps<{
  timelineType: TimelineType
  title: string
  bannerStorageKey?: string
  bannerText?: string
}>()

const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()

// View stack: timeline or thread
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

const timeline = computed(() => timelinesStore.getTimeline(props.timelineType))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})

const hasNewPosts = computed(() => timeline.value.newStatusIds.length > 0)

// Scroll detection uses the closest scrollable parent
const isAtTop = ref(true)

watch(() => timeline.value.newStatusIds.length, (len) => {
  if (len > 0 && isAtTop.value) {
    timelinesStore.showNewStatuses(props.timelineType)
  }
})

function showNew() {
  timelinesStore.showNewStatuses(props.timelineType)
}

async function loadTimeline() {
  await timelinesStore.fetchTimeline(props.timelineType, { token: auth.token ?? undefined })
}

async function loadMore() {
  await timelinesStore.fetchMore(props.timelineType, { token: auth.token ?? undefined })
}

onMounted(loadTimeline)
</script>

<template>
  <div>
    <!-- Timeline view -->
    <template v-if="activeView === 'timeline'">
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h2 class="text-lg font-bold">{{ title }}</h2>
      </header>

      <DismissibleBanner v-if="bannerStorageKey" :storage-key="bannerStorageKey">
        {{ bannerText }}
      </DismissibleBanner>

      <div v-if="timeline.error" class="p-4 text-center text-red-500">
        {{ timeline.error }}
      </div>

      <TimelineFeed
        :statuses="statuses"
        :loading="timeline.loading || timeline.loadingMore"
        :done="!timeline.hasMore"
        :has-new-posts="hasNewPosts"
        :new-posts-count="timeline.newStatusIds.length"
        @load-more="loadMore"
        @load-new="showNew"
        @navigate="openThread"
      />
    </template>

    <!-- Thread view -->
    <ThreadView
      v-else-if="threadStatusId"
      :status-id="threadStatusId"
      @back="backToTimeline"
      @navigate="openThread"
    />
  </div>
</template>
