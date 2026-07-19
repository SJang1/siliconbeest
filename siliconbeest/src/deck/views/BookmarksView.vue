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
  feedKey: () => 'bookmarks',
  visibleStatuses: () => statuses.value,
})

function requestBookmarksPage(cursor: string | undefined, signal?: AbortSignal) {
  const params = cursor ? `?max_id=${cursor}` : ''
  return apiFetch<Status[]>(`/v1/bookmarks${params}`, {
    token: auth.token!,
    signal,
  })
}

async function loadBookmarks() {
  if (loading.value || done.value || !auth.token) return
  loading.value = true
  error.value = null
  try {
    const cursor = maxId.value
    const generation = cursor ? undefined : pagePrefetch.reset()
    const response = cursor
      ? await pagePrefetch.consume(
          cursor,
          signal => requestBookmarksPage(cursor, signal),
        )
      : await requestBookmarksPage(undefined)
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
        signal => requestBookmarksPage(nextCursor, signal),
      )
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
  <DeckPageShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 flex items-center gap-2.5 border-b px-4 py-3">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-4.5 w-4.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" />
          </svg>
        </span>
        <h1 class="sb-heading text-lg">{{ t('nav.bookmarks') }}</h1>
      </header>

      <div class="mx-auto w-full max-w-2xl">
        <div v-if="error" class="px-4 py-3 text-center text-sm font-medium text-red-600 dark:text-red-400">
          {{ error }}
        </div>

        <TimelineFeed
          :statuses="statuses"
          :loading="loading"
          :done="done"
          @load-more="loadBookmarks"
        />
      </div>
    </div>
  </DeckPageShell>
</template>
