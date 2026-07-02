<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'
import AppShell from '@/components/layout/AppShell.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'

const { t } = useI18n()
const route = useRoute()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()
const instanceStore = useInstanceStore()

const tag = computed(() => {
  const value = route.params.tag as string
  // Set dynamic page title for tag page
  if (value) {
    const siteName = instanceStore.instance?.title
    document.title = siteName ? `#${value} | ${siteName}` : `#${value}`
  }
  return value
})

const timeline = computed(() => timelinesStore.getTimeline('tag', tag.value))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})

async function loadTimeline() {
  if (!tag.value) return
  await timelinesStore.fetchTimeline('tag', {
    tag: tag.value,
    token: auth.token ?? undefined,
  })
}

async function loadMore() {
  if (!tag.value) return
  await timelinesStore.fetchMore('tag', {
    tag: tag.value,
    token: auth.token ?? undefined,
  })
}

onMounted(loadTimeline)

watch(tag, () => {
  loadTimeline()
})
</script>

<template>
  <AppShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-3">
        <button
          @click="$router.back()"
          class="shrink-0 rounded-full p-2 text-slate-600 transition-colors hover:bg-surface-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-300 dark:hover:bg-surface-2-dark dark:hover:text-white"
          :aria-label="t('common.back')"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
        </button>
        <h1 class="sb-heading min-w-0 text-lg">
          <span class="sb-chip max-w-full px-3 py-1 text-sm font-semibold">
            <span class="truncate">#{{ tag }}</span>
          </span>
        </h1>
      </header>

      <div v-if="timeline.error" class="mx-4 my-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-center text-sm font-medium text-red-600 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400">
        {{ timeline.error }}
      </div>

      <TimelineFeed
        :statuses="statuses"
        :loading="timeline.loading || timeline.loadingMore"
        :done="!timeline.hasMore"
        @load-more="loadMore"
      />
    </div>
  </AppShell>
</template>
