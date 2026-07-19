<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { apiFetch, parseLinkHeader } from '@/api/client'
import { useStatusPagePrefetch } from '@/composables/useStatusPagePrefetch'
import { useAuthStore } from '@/stores/auth'
import DeckPageShell from '@/deck/layout/DeckPageShell.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'

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
  <DeckPageShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 flex items-center gap-2.5 border-b px-4 py-3">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-4.5 w-4.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
          </svg>
        </span>
        <h1 class="sb-heading text-lg">{{ t('nav.favourites') }}</h1>
      </header>

      <div class="mx-auto w-full max-w-2xl">
        <div v-if="error" class="px-4 py-3 text-center text-sm font-medium text-red-600 dark:text-red-400">
          {{ error }}
        </div>

        <TimelineFeed
          :statuses="statuses"
          :loading="loading"
          :done="done"
          @load-more="loadFavourites"
        />
      </div>
    </div>
  </DeckPageShell>
</template>
