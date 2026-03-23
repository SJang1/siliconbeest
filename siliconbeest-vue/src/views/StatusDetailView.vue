<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
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

const status = ref<Status | null>(null)
const ancestors = ref<Status[]>([])
const descendants = ref<Status[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

async function loadThread() {
  loading.value = true
  error.value = null
  const id = route.params.statusId as string
  if (!id) return

  try {
    const { data: statusData } = await getStatus(id, auth.token ?? undefined)
    status.value = statusData
    statusesStore.cacheStatus(statusData)

    const { data: context } = await getStatusContext(id, auth.token ?? undefined)
    ancestors.value = context.ancestors
    descendants.value = context.descendants
  } catch (e) {
    error.value = (e as Error).message
    status.value = null
  } finally {
    loading.value = false
  }
}

const replyTarget = ref<Status | null>(null)

function setReplyTarget(s: Status) {
  replyTarget.value = s
}

async function handleReply(payload: { content: string; visibility?: string; sensitive?: boolean; spoiler_text?: string }) {
  if (!auth.token || !status.value) return
  const target = replyTarget.value ?? status.value
  try {
    await createStatus({
      status: payload.content,
      in_reply_to_id: target.id,
      visibility: (payload.visibility as any) ?? target.visibility,
      sensitive: payload.sensitive,
      spoiler_text: payload.spoiler_text,
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
        <StatusCard v-for="s in ancestors" :key="s.id" :status="s" />

        <!-- Main status -->
        <div class="border-l-4 border-indigo-500">
          <StatusCard :status="status" />
        </div>

        <!-- Descendants -->
        <StatusCard v-for="s in descendants" :key="s.id" :status="s" @reply="setReplyTarget(s)" />

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
