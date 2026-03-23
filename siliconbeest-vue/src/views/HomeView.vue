<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import type { Status } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import StatusComposer from '@/components/status/StatusComposer.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'

const { t } = useI18n()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()
const compose = useComposeStore()

const timeline = computed(() => timelinesStore.getTimeline('home'))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})

const hasNewPosts = computed(() => timeline.value.newStatusIds.length > 0)

async function loadTimeline() {
  if (!auth.token) return
  await timelinesStore.fetchTimeline('home', { token: auth.token })
}

async function loadMore() {
  if (!auth.token) return
  await timelinesStore.fetchMore('home', { token: auth.token })
}

async function handleCompose(payload: { content: string; visibility?: string; sensitive?: boolean; spoiler_text?: string; language?: string }) {
  if (!auth.token) return
  compose.text = payload.content
  if (payload.visibility) compose.visibility = payload.visibility as any
  if (payload.sensitive) compose.sensitive = payload.sensitive
  if (payload.spoiler_text) {
    compose.contentWarning = payload.spoiler_text
    compose.showContentWarning = true
  }
  if (payload.language) compose.language = payload.language
  await compose.publish()
}

function showNew() {
  timelinesStore.showNewStatuses('home')
}

onMounted(loadTimeline)
</script>

<template>
  <AppShell>
    <div>
      <!-- Header -->
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('nav.home') }}</h1>
      </header>

      <!-- Composer -->
      <StatusComposer @submit="handleCompose" />

      <!-- Error -->
      <div v-if="timeline.error" class="p-4 text-center text-red-500">
        {{ timeline.error }}
      </div>

      <!-- Feed -->
      <TimelineFeed
        :statuses="statuses"
        :loading="timeline.loading || timeline.loadingMore"
        :done="!timeline.hasMore"
        :has-new-posts="hasNewPosts"
        :new-posts-count="timeline.newStatusIds.length"
        @load-more="loadMore"
        @load-new="showNew"
      />
    </div>
  </AppShell>
</template>
