<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import type { TimelineType } from '@/stores/timelines'
import TimelineFeed from './TimelineFeed.vue'
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

const timeline = computed(() => timelinesStore.getTimeline(props.timelineType))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})

const hasNewPosts = computed(() => timeline.value.newStatusIds.length > 0)

const isAtTop = ref(true)
let scrollTimer: ReturnType<typeof setTimeout> | null = null

function handleScroll() {
  if (scrollTimer) return
  scrollTimer = setTimeout(() => {
    isAtTop.value = window.scrollY < 100
    scrollTimer = null
  }, 100)
}

onMounted(() => {
  window.addEventListener('scroll', handleScroll, { passive: true })
  loadTimeline()
})

onUnmounted(() => {
  window.removeEventListener('scroll', handleScroll)
  if (scrollTimer) clearTimeout(scrollTimer)
})

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
</script>

<template>
  <div>
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
      :has-new-posts="hasNewPosts && !isAtTop"
      :new-posts-count="timeline.newStatusIds.length"
      @load-more="loadMore"
      @load-new="showNew"
    />
  </div>
</template>
