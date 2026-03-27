<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { apiFetch, parseLinkHeader } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/components/layout/AppShell.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'

const { t } = useI18n()
const auth = useAuthStore()

const statuses = ref<Status[]>([])
const loading = ref(false)
const done = ref(false)
const maxId = ref<string>()
const error = ref<string | null>(null)

async function loadBookmarks() {
  if (loading.value || done.value || !auth.token) return
  loading.value = true
  error.value = null
  try {
    const params = maxId.value ? `?max_id=${maxId.value}` : ''
    const { data, headers } = await apiFetch<Status[]>(`/v1/bookmarks${params}`, {
      token: auth.token,
    })
    statuses.value.push(...data)
    const links = parseLinkHeader(headers.get('Link'))
    done.value = !links.next
    if (data.length > 0) {
      maxId.value = data[data.length - 1]!.id
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(loadBookmarks)
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('nav.bookmarks') }}</h1>
      </header>

      <div v-if="error" class="p-4 text-center text-red-500">
        {{ error }}
      </div>

      <TimelineFeed
        :statuses="statuses"
        :loading="loading"
        :done="done"
        @load-more="loadBookmarks"
      />
    </div>
  </AppShell>
</template>
