<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { getStatus, getStatusContext, createStatus } from '@/api/mastodon/statuses'
import { useAuthStore } from '@/stores/auth'
import { useStatusesStore } from '@/stores/statuses'
import AppShell from '@/components/layout/AppShell.vue'
import StatusCard from '@/components/status/StatusCard.vue'
import StatusComposer from '@/components/status/StatusComposer.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const statusesStore = useStatusesStore()

const statusId = ref<string | null>(null)
const ancestorIds = ref<string[]>([])
const descendantIds = ref<string[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// Resolve statuses from store cache for reactive updates
const status = computed(() => statusId.value ? statusesStore.cache.get(statusId.value) ?? null : null)
const ancestors = computed(() => ancestorIds.value.map((id) => statusesStore.cache.get(id)).filter(Boolean) as Status[])
const descendants = computed(() => descendantIds.value.map((id) => statusesStore.cache.get(id)).filter(Boolean) as Status[])

// Build threaded tree with depth for indentation
interface ThreadedStatus {
  status: Status
  depth: number
}

const threadedDescendants = computed<ThreadedStatus[]>(() => {
  if (!status.value || descendants.value.length === 0) return []

  const mainId = status.value.id
  const childrenMap = new Map<string, Status[]>()
  for (const s of descendants.value) {
    const parentId = s.in_reply_to_id ?? mainId
    const list = childrenMap.get(parentId) ?? []
    list.push(s)
    childrenMap.set(parentId, list)
  }

  const result: ThreadedStatus[] = []
  function walk(parentId: string, depth: number) {
    const children = childrenMap.get(parentId)
    if (!children) return
    for (const child of children) {
      result.push({ status: child, depth: Math.min(depth, 4) })
      walk(child.id, depth + 1)
    }
  }
  walk(mainId, 0)
  return result
})

async function loadThread() {
  loading.value = true
  error.value = null
  const id = route.params.statusId as string
  if (!id) return

  try {
    const { data: statusData } = await getStatus(id, auth.token ?? undefined)
    statusesStore.cacheStatus(statusData)
    statusId.value = statusData.id

    const { data: context } = await getStatusContext(id, auth.token ?? undefined)
    // Cache all statuses and store their IDs
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

const replyTarget = ref<Status | null>(null)

function setReplyTarget(s: Status) {
  replyTarget.value = s
}

function handleDeleted(deletedId: string) {
  // Remove from descendant IDs
  descendantIds.value = descendantIds.value.filter((id) => id !== deletedId)
  // If the main status was deleted, go back
  if (statusId.value === deletedId) {
    router.back()
  }
}

async function handleReply(payload: { content: string; visibility?: string; sensitive?: boolean; spoiler_text?: string; media_ids?: string[] }) {
  if (!auth.token || !status.value) return
  const target = replyTarget.value ?? status.value
  try {
    await createStatus({
      status: payload.content,
      in_reply_to_id: target.id,
      visibility: (payload.visibility as any) ?? target.visibility,
      sensitive: payload.sensitive,
      spoiler_text: payload.spoiler_text,
      media_ids: payload.media_ids,
    }, auth.token)
    // Reload full thread to get correct ordering
    await loadThread()
    replyTarget.value = null
  } catch (e) {
    // silently fail
  }
}

onMounted(loadThread)

watch(() => route.params.statusId, (newId) => {
  if (newId) loadThread()
})
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center gap-3">
        <button @click="router.back()" class="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800" :aria-label="t('common.back')">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <h1 class="text-xl font-bold">{{ t('status.thread') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <template v-else-if="status">
        <!-- Ancestors -->
        <StatusCard v-for="s in ancestors" :key="s.id" :status="s" @deleted="handleDeleted" />

        <!-- Main status -->
        <div class="border-l-4 border-indigo-500">
          <StatusCard :status="status" @deleted="handleDeleted" />
        </div>

        <!-- Descendants (threaded with indentation) -->
        <div
          v-for="item in threadedDescendants"
          :key="item.status.id"
          :style="{ marginLeft: `${item.depth * 24}px` }"
          :class="item.depth > 0 ? 'border-l-2 border-gray-200 dark:border-gray-700' : ''"
        >
          <StatusCard :status="item.status" @reply="setReplyTarget(item.status)" @deleted="handleDeleted" />
        </div>

        <!-- Reply composer (below all replies) -->
        <div v-if="replyTarget && replyTarget.id !== status.id" class="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700 flex items-center gap-2">
          <span>{{ t('status.replying_to') }} @{{ replyTarget.account.acct }}</span>
          <button @click="replyTarget = null" class="text-indigo-500 hover:underline text-xs">{{ t('common.cancel') }}</button>
        </div>
        <StatusComposer :reply-to="replyTarget ?? status" @submit="handleReply" />
      </template>

      <div v-else class="p-8 text-center text-gray-500 dark:text-gray-400">
        {{ error || t('status.not_found') }}
      </div>
    </div>
  </AppShell>
</template>
