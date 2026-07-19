<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { apiFetch, parseLinkHeader } from '@/api/client'
import { useStatusPagePrefetch } from '@/composables/useStatusPagePrefetch'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/legacy/components/layout/AppShell.vue'
import TimelineFeed from '@/legacy/components/timeline/TimelineFeed.vue'

const { t } = useI18n()
const auth = useAuthStore()

const statuses = ref<Status[]>([])
const loading = ref(false)
const done = ref(false)
const maxId = ref<string>()
const error = ref<string | null>(null)
const pagePrefetch = useStatusPagePrefetch({
  feedKey: () => 'favourites',
  visibleStatuses: () => statuses.value,
})

function requestFavouritesPage(cursor: string | undefined, signal?: AbortSignal) {
  const params = cursor ? `?max_id=${cursor}` : ''
  return apiFetch<Status[]>(`/v1/favourites${params}`, {
    token: auth.token!,
    signal,
  })
}

async function loadFavourites() {
  if (loading.value || done.value || !auth.token) return
  loading.value = true
  error.value = null
  try {
    const cursor = maxId.value
    const generation = cursor ? undefined : pagePrefetch.reset()
    const response = cursor
      ? await pagePrefetch.consume(
          cursor,
          signal => requestFavouritesPage(cursor, signal),
        )
      : await requestFavouritesPage(undefined)
    if (!response || (generation !== undefined && !pagePrefetch.isCurrent(generation))) return
    const { data, headers } = response
    statuses.value.push(...data)
    const links = parseLinkHeader(headers.get('Link'))
    done.value = !links.next || data.length === 0
    if (data.length > 0) {
      maxId.value = data[data.length - 1]!.id
    }
    if (!done.value && maxId.value) {
      const nextCursor = maxId.value
      pagePrefetch.prefetch(
        nextCursor,
        signal => requestFavouritesPage(nextCursor, signal),
      )
    }
  } catch (e) {
    error.value = (e as Error).message
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

      <div v-if="error" class="p-4 text-center text-red-500">
        {{ error }}
      </div>

      <TimelineFeed
        :statuses="statuses"
        :loading="loading"
        :done="done"
        @load-more="loadFavourites"
      />
    </div>
  </AppShell>
</template>
