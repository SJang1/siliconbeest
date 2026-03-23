<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import StatusComposer from '@/components/status/StatusComposer.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'

const { t } = useI18n()

const statuses = ref<Status[]>([])
const loading = ref(false)
const done = ref(false)
const hasNewPosts = ref(false)

async function loadTimeline() {
  if (loading.value || done.value) return
  loading.value = true
  try {
    // TODO: fetch from API
    // const res = await api.getHomeTimeline({ max_id: lastId })
  } finally {
    loading.value = false
  }
}

async function handleCompose(payload: { content: string; visibility?: string; sensitive?: boolean; spoiler_text?: string }) {
  // TODO: post to API
  console.log('compose', payload)
}

onMounted(() => {
  loadTimeline()
})
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

      <!-- Feed -->
      <TimelineFeed
        :statuses="statuses"
        :loading="loading"
        :done="done"
        :has-new-posts="hasNewPosts"
        @load-more="loadTimeline"
        @load-new="hasNewPosts = false"
      />
    </div>
  </AppShell>
</template>
