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
    const siteName = instanceStore.instance?.title || 'SiliconBeest'
    document.title = `#${value} | ${siteName}`
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
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center gap-3">
        <button @click="$router.back()" class="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800" :aria-label="t('common.back')">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <h1 class="text-xl font-bold">#{{ tag }}</h1>
      </header>

      <div v-if="timeline.error" class="p-4 text-center text-red-500">
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
