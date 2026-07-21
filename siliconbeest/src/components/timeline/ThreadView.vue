<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { getStatus, getStatusContext } from '@/api/mastodon/statuses'
import { useAuthStore } from '@/stores/auth'
import { useStatusesStore } from '@/stores/statuses'
import ThreadConversation from '@/components/timeline/ThreadConversation.vue'
import { getThreadSubtreeIds } from '@/components/timeline/threadTree'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const auth = useAuthStore()
const statusesStore = useStatusesStore()

const props = defineProps<{
  statusId: string
}>()

const emit = defineEmits<{
  back: []
  navigate: [status: Status]
}>()

const currentStatusId = ref<string | null>(null)
const ancestorIds = ref<string[]>([])
const descendantIds = ref<string[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const status = computed(() =>
  currentStatusId.value ? statusesStore.cache.get(currentStatusId.value) ?? null : null
)
const ancestors = computed(() =>
  ancestorIds.value.map((id) => statusesStore.cache.get(id)).filter(Boolean) as Status[]
)
const descendants = computed(() =>
  descendantIds.value.map((id) => statusesStore.cache.get(id)).filter(Boolean) as Status[]
)

async function loadThread() {
  loading.value = true
  error.value = null
  const id = props.statusId
  if (!id) return

  try {
    const { data: statusData } = await getStatus(id, auth.token ?? undefined)
    statusesStore.cacheStatus(statusData)
    currentStatusId.value = statusData.id

    const { data: context } = await getStatusContext(id, auth.token ?? undefined)
    for (const s of context.ancestors) statusesStore.cacheStatus(s)
    for (const s of context.descendants) statusesStore.cacheStatus(s)
    ancestorIds.value = context.ancestors.map((s: Status) => s.id)
    descendantIds.value = context.descendants.map((s: Status) => s.id)
  } catch (e) {
    error.value = (e as Error).message
    currentStatusId.value = null
  } finally {
    loading.value = false
  }
}

function handleDeleted(deletedId: string) {
  const deletedSubtreeIds = getThreadSubtreeIds(descendants.value, deletedId)
  descendantIds.value = descendantIds.value.filter((id) => !deletedSubtreeIds.has(id))
  if (currentStatusId.value === deletedId) {
    emit('back')
  }
}

function handleNavigate(s: Status) {
  emit('navigate', s)
}

onMounted(loadThread)

watch(() => props.statusId, () => {
  loadThread()
})
</script>

<template>
  <div>
    <header class="sb-glass sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-3">
      <button
        @click="emit('back')"
        class="rounded-full p-1.5 text-slate-600 transition hover:bg-surface-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-300 dark:hover:bg-surface-2-dark dark:hover:text-white"
        :aria-label="t('common.back')"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
      </button>
      <h2 class="sb-heading text-lg">{{ t('status.thread') }}</h2>
    </header>

    <LoadingSpinner v-if="loading" />

    <div v-else-if="status" class="px-3 py-4 sm:px-4">
      <ThreadConversation
        :status="status"
        :ancestors="ancestors"
        :descendants="descendants"
        @navigate="handleNavigate"
        @deleted="handleDeleted"
      />
    </div>

    <div v-else class="sb-empty px-6">
      {{ error || t('status.not_found') }}
    </div>
  </div>
</template>
