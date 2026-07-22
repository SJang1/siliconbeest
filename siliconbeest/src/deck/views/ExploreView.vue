<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { Status } from '@/types/mastodon'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import type { TimelineType } from '@/stores/timelines'
import { useAudibleTimelineScope } from '@/composables/useAudibleTimelineScope'
import DeckPageShell from '@/deck/layout/DeckPageShell.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'
import DismissibleBanner from '@/components/common/DismissibleBanner.vue'
import { useTimelineStreamViewport } from '@/composables/useTimelineStreamViewport'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()

type ExploreTab = 'local' | 'federated'

const activeTab = computed<ExploreTab>(() =>
  (route.params.tab as string) === 'public' ? 'federated' : 'local'
)

const timelineType = computed<TimelineType>(() =>
  activeTab.value === 'federated' ? 'public' : 'local'
)

useAudibleTimelineScope('deck-explore', () => [timelineType.value])

const timeline = computed(() => timelinesStore.getTimeline(timelineType.value))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})

const newStatusCount = computed(() => timelinesStore.getNewStatusCount(timelineType.value))
const hasNewPosts = computed(() => newStatusCount.value > 0)

// Auto-insert new posts when user is at top of page
const isAtTop = ref(true)
useTimelineStreamViewport('deck-explore', timelineType, isAtTop)
let scrollTimer: ReturnType<typeof setTimeout> | null = null

function handleScroll() {
  if (scrollTimer) return
  scrollTimer = setTimeout(() => {
    isAtTop.value = window.scrollY < 100
    scrollTimer = null
  }, 100)
}

onMounted(() => window.addEventListener('scroll', handleScroll, { passive: true }))
onUnmounted(() => {
  window.removeEventListener('scroll', handleScroll)
  if (scrollTimer) clearTimeout(scrollTimer)
})

watch(newStatusCount, (len) => {
  if (len > 0 && isAtTop.value) {
    timelinesStore.showNewStatuses(timelineType.value)
  }
})

function showNew() {
  timelinesStore.showNewStatuses(timelineType.value)
}

async function loadTimeline() {
  await timelinesStore.fetchTimeline(timelineType.value, { token: auth.token ?? undefined })
}

async function loadMore() {
  await timelinesStore.fetchMore(timelineType.value, { token: auth.token ?? undefined })
}

function switchTab(tab: ExploreTab) {
  const urlTab = tab === 'federated' ? 'public' : 'local'
  router.push(`/explore/${urlTab}`)
}

watch(
  [() => route.params.tab, () => auth.token],
  () => {
    void loadTimeline()
  },
  { immediate: true },
)
</script>

<template>
  <DeckPageShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 border-b px-4 py-3">
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h1 class="sb-heading text-lg">{{ activeTab === 'federated' ? t('nav.federated_timeline') : t('nav.local_timeline') }}</h1>
          <div class="inline-flex items-center gap-1 rounded-full border border-outline bg-surface-2 p-1 dark:border-outline-dark dark:bg-surface-2-dark">
            <button
              type="button"
              class="rounded-full px-4 py-1.5 text-sm font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
              :class="activeTab === 'local'
                ? 'bg-brand-600 text-white shadow-soft dark:bg-brand-500'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'"
              :aria-pressed="activeTab === 'local'"
              @click="switchTab('local')"
            >
              {{ t('timeline.local') }}
            </button>
            <button
              type="button"
              class="rounded-full px-4 py-1.5 text-sm font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
              :class="activeTab === 'federated'
                ? 'bg-brand-600 text-white shadow-soft dark:bg-brand-500'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'"
              :aria-pressed="activeTab === 'federated'"
              @click="switchTab('federated')"
            >
              {{ t('timeline.federated') }}
            </button>
          </div>
        </div>
      </header>

      <DismissibleBanner
        v-if="activeTab === 'local'"
        storage-key="siliconbeest_banner_dismissed_local"
      >
        {{ t('timeline.local_banner') }}
      </DismissibleBanner>
      <DismissibleBanner
        v-if="activeTab === 'federated'"
        storage-key="siliconbeest_banner_dismissed_federated"
      >
        {{ t('timeline.federated_banner') }}
      </DismissibleBanner>

      <div v-if="timeline.error" class="mx-4 my-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-center text-sm font-medium text-red-600 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400">
        {{ timeline.error }}
      </div>

      <TimelineFeed
        :statuses="statuses"
        :timeline-key="timelineType"
        show-advertisements
        :loading="timeline.loading || timeline.loadingMore"
        :done="!timeline.hasMore"
        :has-new-posts="hasNewPosts"
        :new-posts-count="newStatusCount"
        :auto-insert="isAtTop"
        @load-more="loadMore"
        @load-new="showNew"
      />
    </div>
  </DeckPageShell>
</template>
