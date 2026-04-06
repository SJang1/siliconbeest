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
import DismissibleBanner from '@/components/common/DismissibleBanner.vue'

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
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ activeTab === 'federated' ? t('nav.federated_timeline') : t('nav.local_timeline') }}</h1>
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
