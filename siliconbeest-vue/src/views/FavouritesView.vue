<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'

const { t } = useI18n()

const statuses = ref<Status[]>([])
const loading = ref(false)
const done = ref(false)

async function loadFavourites() {
  if (loading.value || done.value) return
  loading.value = true
  try {
    // TODO: fetch from API
    // const res = await api.getFavourites({ max_id: lastId })
  } finally {
    loading.value = false
  }
}

onMounted(loadFavourites)
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('nav.favourites') }}</h1>
      </header>

      <TimelineFeed
        :statuses="statuses"
        :loading="loading"
        :done="done"
        @load-more="loadFavourites"
      />
    </div>
  </AppShell>
</template>
