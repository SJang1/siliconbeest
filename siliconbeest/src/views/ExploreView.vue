<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { Status } from '@/types/mastodon'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import type { TimelineType } from '@/stores/timelines'
import AppShell from '@/components/layout/AppShell.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'

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

const timeline = computed(() => timelinesStore.getTimeline(timelineType.value))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})

const hasNewPosts = computed(() => timeline.value.newStatusIds.length > 0)

// Auto-insert new posts when user is at top of page
const isAtTop = ref(true)
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

watch(() => timeline.value.newStatusIds.length, (len) => {
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

watch(() => route.params.tab, () => {
  loadTimeline()
})

onMounted(loadTimeline)
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700">
        <h1 class="text-xl font-bold px-4 py-3">{{ t('nav.explore') }}</h1>
        <div class="flex border-b border-gray-200 dark:border-gray-700">
          <button
            v-for="tab in (['local', 'federated'] as ExploreTab[])"
            :key="tab"
            @click="switchTab(tab)"
            class="flex-1 py-3 text-center text-sm font-medium transition-colors relative"
            :class="activeTab === tab
              ? 'text-indigo-600 dark:text-indigo-400'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'"
          >
            {{ t(`explore.${tab}`) }}
            <div
              v-if="activeTab === tab"
              class="absolute bottom-0 left-1/4 right-1/4 h-1 bg-indigo-600 dark:bg-indigo-400 rounded-full"
            />
          </button>
        </div>
      </header>

      <div v-if="timeline.error" class="p-4 text-center text-red-500">
        {{ timeline.error }}
      </div>

      <TimelineFeed
        :statuses="statuses"
        :loading="timeline.loading || timeline.loadingMore"
        :done="!timeline.hasMore"
        :has-new-posts="hasNewPosts"
        :new-posts-count="timeline.newStatusIds.length"
        :auto-insert="isAtTop"
        @load-more="loadMore"
        @load-new="showNew"
      />
    </div>
  </AppShell>
</template>
