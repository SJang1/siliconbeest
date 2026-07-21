<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { getStatus, getStatusContext } from '@/api/mastodon/statuses'
import { useAuthStore } from '@/stores/auth'
import { useStatusesStore } from '@/stores/statuses'
import { useInstanceStore } from '@/stores/instance'
import DeckPageShell from '@/deck/layout/DeckPageShell.vue'
import ThreadConversation from '@/components/timeline/ThreadConversation.vue'
import { getThreadSubtreeIds } from '@/components/timeline/threadTree'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const statusesStore = useStatusesStore()
const instanceStore = useInstanceStore()

const statusId = ref<string | null>(null)
const ancestorIds = ref<string[]>([])
const descendantIds = ref<string[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const status = computed(() => statusId.value ? statusesStore.cache.get(statusId.value) ?? null : null)
const ancestors = computed(() => ancestorIds.value.map((id) => statusesStore.cache.get(id)).filter(Boolean) as Status[])
const descendants = computed(() => descendantIds.value.map((id) => statusesStore.cache.get(id)).filter(Boolean) as Status[])

async function loadThread() {
  loading.value = true
  error.value = null
  const id = route.params.statusId as string
  if (!id) return

  try {
    const { data: statusData } = await getStatus(id, auth.token ?? undefined)
    statusesStore.cacheStatus(statusData)
    statusId.value = statusData.id

    const siteName = instanceStore.instance?.title
    const displayName = statusData.account?.display_name || statusData.account?.username || ''
    const acct = statusData.account?.acct || ''
    const contentSnippet = (statusData.content || '').replace(/<[^>]*>/g, '').substring(0, 50)
    const statusTitle = statusData.object_type === 'Article' && statusData.title
      ? statusData.title
      : contentSnippet
      ? `${displayName}: "${contentSnippet}"`
      : `${displayName} (@${acct})`
    document.title = siteName ? `${statusTitle} | ${siteName}` : statusTitle

    const { data: context } = await getStatusContext(id, auth.token ?? undefined)
    for (const s of context.ancestors) statusesStore.cacheStatus(s)
    for (const s of context.descendants) statusesStore.cacheStatus(s)
    ancestorIds.value = context.ancestors.map((s: Status) => s.id)
    descendantIds.value = context.descendants.map((s: Status) => s.id)
  } catch (e) {
    error.value = (e as Error).message
    statusId.value = null
  } finally {
    loading.value = false
  }
}

function handleDeleted(deletedId: string) {
  const deletedSubtreeIds = getThreadSubtreeIds(descendants.value, deletedId)
  descendantIds.value = descendantIds.value.filter((id) => !deletedSubtreeIds.has(id))
  if (statusId.value === deletedId) {
    router.back()
  }
}

function handleNavigate(s: Status) {
  router.push(`/@${s.account.acct}/${s.id}`)
}

onMounted(loadThread)

watch(() => route.params.statusId, (newId) => {
  if (newId) loadThread()
})
</script>

<template>
  <DeckPageShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-3">
        <button @click="router.back()" class="sb-btn sb-btn-ghost -ml-2 shrink-0 rounded-full p-2" :aria-label="t('common.back')">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
        </button>
        <h1 class="sb-heading truncate text-lg">{{ t('status.thread') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <div v-else-if="status" class="mx-auto w-full max-w-2xl animate-fade-in px-4 py-4">
        <ThreadConversation
          :status="status"
          :ancestors="ancestors"
          :descendants="descendants"
          variant="deck"
          @navigate="handleNavigate"
          @deleted="handleDeleted"
        />
      </div>

      <div v-else class="sb-empty px-4">
        <svg class="h-8 w-8 text-slate-300 dark:text-slate-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"/></svg>
        <p>{{ error || t('status.not_found') }}</p>
      </div>
    </div>
  </DeckPageShell>
</template>
