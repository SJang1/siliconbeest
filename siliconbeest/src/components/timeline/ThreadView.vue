<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { getStatus, getStatusContext } from '@/api/mastodon/statuses'
import { useAuthStore } from '@/stores/auth'
import { useStatusesStore } from '@/stores/statuses'
import StatusCard from '@/components/status/StatusCard.vue'
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
  descendantIds.value = descendantIds.value.filter((id) => id !== deletedId)
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

    <template v-else-if="status">
      <!-- Ancestors -->
      <div v-if="ancestors.length > 0" class="border-l-2 border-brand-200/80 dark:border-brand-800/60">
        <StatusCard v-for="s in ancestors" :key="s.id" :status="s" @navigate="handleNavigate" @deleted="handleDeleted" />
      </div>

      <!-- Main status -->
      <div class="relative bg-brand-50/40 dark:bg-brand-950/15">
        <span class="absolute inset-y-0 left-0 w-1 bg-linear-to-b from-brand-500 via-violet-500 to-fuchsia-500" aria-hidden="true"></span>
        <StatusCard :status="status" @navigate="handleNavigate" @deleted="handleDeleted" />
      </div>

      <!-- Descendants -->
      <div
        v-for="item in threadedDescendants"
        :key="item.status.id"
        :style="{ marginLeft: `${item.depth * 24}px` }"
        :class="item.depth > 0 ? 'border-l-2 border-brand-200/70 dark:border-brand-800/50' : ''"
      >
        <StatusCard :status="item.status" @navigate="handleNavigate" @deleted="handleDeleted" />
      </div>
    </template>

    <div v-else class="sb-empty px-6">
      {{ error || t('status.not_found') }}
    </div>
  </div>
</template>
