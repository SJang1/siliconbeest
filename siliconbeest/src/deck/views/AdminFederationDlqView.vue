<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import {
  getFederationDlq,
  replayFederationDlqMessage,
  discardFederationDlqMessage,
  processFederationDlqMessages,
  type FederationDlqMessage,
} from '@/api/mastodon/admin'
import DeckAdminLayout from '@/deck/layout/DeckAdminLayout.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const auth = useAuthStore()

const STATUSES = ['parked', 'replayed', 'discarded'] as const
const LIMIT = 50

const loading = ref(false)
const error = ref<string | null>(null)
const messages = ref<FederationDlqMessage[]>([])
const counts = ref<Record<string, number>>({})
const statusFilter = ref<string>('parked')
const expandedId = ref<string | null>(null)
const busyId = ref<string | null>(null)
const bulkBusy = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const hasMore = ref(false)

const selectableMessages = computed(() => messages.value.filter((msg) => msg.status === 'parked'))
const actionBusy = computed(() => bulkBusy.value || busyId.value !== null)
const allVisibleSelected = computed(() => (
  selectableMessages.value.length > 0
  && selectableMessages.value.every((msg) => selectedIds.value.has(msg.id))
))

function statusChipClasses(status: string): string {
  if (status === 'parked') {
    return 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
  }
  if (status === 'replayed') {
    return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
  }
  return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString()
}

function activityLabel(msg: FederationDlqMessage): string {
  if (msg.activity_type) return msg.activity_type
  return msg.message_type ?? '-'
}

function errorSummary(msg: FederationDlqMessage): string {
  if (!msg.error) return '-'
  return msg.error.split('\n')[0] ?? msg.error
}

function prettyBody(msg: FederationDlqMessage): string {
  try {
    return JSON.stringify(msg.body, null, 2)
  } catch {
    return String(msg.body)
  }
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

async function load(append = false) {
  loading.value = true
  error.value = null
  try {
    const params: Record<string, string> = {
      status: statusFilter.value,
      limit: String(LIMIT),
    }
    if (append && messages.value.length > 0) {
      params.offset = String(messages.value.length)
    }
    const res = await getFederationDlq(auth.token!, params)
    messages.value = append ? [...messages.value, ...res.data.items] : res.data.items
    if (!append) selectedIds.value = new Set()
    counts.value = res.data.counts
    hasMore.value = res.data.items.length >= LIMIT
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function setFilter(status: string) {
  if (statusFilter.value === status) return
  statusFilter.value = status
  expandedId.value = null
  load(false)
}

function toggleSelection(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function toggleAllVisible() {
  const next = new Set(selectedIds.value)
  if (allVisibleSelected.value) {
    selectableMessages.value.forEach((msg) => next.delete(msg.id))
  } else {
    selectableMessages.value.forEach((msg) => next.add(msg.id))
  }
  selectedIds.value = next
}

async function processBulk(action: 'replay' | 'discard', all: boolean) {
  if (actionBusy.value) return
  const count = all ? (counts.value.parked ?? 0) : selectedIds.value.size
  if (count === 0) return
  const confirmKey = all
    ? `admin.federation.dlq.${action}_all_confirm`
    : `admin.federation.dlq.${action}_selected_confirm`
  if (!confirm(t(confirmKey, { count }))) return

  bulkBusy.value = true
  error.value = null
  try {
    const options = all ? { all: true as const } : { ids: [...selectedIds.value] }
    await processFederationDlqMessages(auth.token!, action, options)
    await load(false)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    bulkBusy.value = false
  }
}

async function replay(msg: FederationDlqMessage) {
  busyId.value = msg.id
  error.value = null
  try {
    await replayFederationDlqMessage(auth.token!, msg.id)
    await load(false)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busyId.value = null
  }
}

async function discard(msg: FederationDlqMessage) {
  if (!confirm(t('admin.federation.dlq.discard_confirm'))) return
  busyId.value = msg.id
  error.value = null
  try {
    await discardFederationDlqMessage(auth.token!, msg.id)
    await load(false)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busyId.value = null
  }
}

onMounted(() => {
  load()
})
</script>

<template>
  <DeckAdminLayout>
    <div class="w-full max-w-6xl animate-fade-in">
      <div class="mb-2 flex items-center gap-3">
        <router-link
          to="/admin/federation"
          class="rounded-xl p-1.5 text-slate-500 no-underline transition-colors hover:bg-surface-2 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-surface-2-dark dark:hover:text-white"
          :aria-label="t('common.back')"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
        </router-link>
        <h1 class="sb-heading text-2xl text-slate-900 dark:text-white">
          {{ t('admin.federation.dlq.title') }}
        </h1>
      </div>
      <p class="mb-6 text-sm text-slate-500 dark:text-slate-400">
        {{ t('admin.federation.dlq.description') }}
      </p>

      <!-- Status filter chips -->
      <div class="mb-4 flex flex-wrap gap-2">
        <button
          v-for="status in STATUSES"
          :key="status"
          class="sb-chip cursor-pointer transition-colors"
          :class="statusFilter === status
            ? 'ring-2 ring-brand-400 ' + statusChipClasses(status)
            : statusChipClasses(status)"
          :disabled="actionBusy"
          @click="setFilter(status)"
        >
          {{ t(`admin.federation.dlq.${status}`) }}
          <span class="ml-1 font-semibold">{{ counts[status] ?? 0 }}</span>
        </button>
      </div>

      <div
        v-if="statusFilter === 'parked' && (counts.parked ?? 0) > 0"
        class="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-outline bg-surface-2 px-3 py-2 dark:border-outline-dark dark:bg-surface-2-dark"
      >
        <span class="mr-auto text-sm text-slate-600 dark:text-slate-300">
          {{ t('admin.federation.dlq.selected_count', { count: selectedIds.size }) }}
        </span>
        <button
          :disabled="actionBusy || selectedIds.size === 0"
          class="sb-btn sb-btn-secondary sb-btn-sm text-emerald-700 dark:text-emerald-300"
          @click="processBulk('replay', false)"
        >
          {{ t('admin.federation.dlq.replay_selected') }}
        </button>
        <button
          :disabled="actionBusy || selectedIds.size === 0"
          class="sb-btn sb-btn-secondary sb-btn-sm text-red-600 dark:text-red-400"
          @click="processBulk('discard', false)"
        >
          {{ t('admin.federation.dlq.discard_selected') }}
        </button>
        <span class="mx-1 h-5 w-px bg-outline dark:bg-outline-dark" aria-hidden="true"></span>
        <button
          :disabled="actionBusy"
          class="sb-btn sb-btn-secondary sb-btn-sm text-emerald-700 dark:text-emerald-300"
          @click="processBulk('replay', true)"
        >
          {{ t('admin.federation.dlq.replay_all') }}
        </button>
        <button
          :disabled="actionBusy"
          class="sb-btn sb-btn-secondary sb-btn-sm text-red-600 dark:text-red-400"
          @click="processBulk('discard', true)"
        >
          {{ t('admin.federation.dlq.discard_all') }}
        </button>
      </div>

      <!-- Error -->
      <div v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
        {{ error }}
      </div>

      <LoadingSpinner v-if="loading && messages.length === 0" />

      <!-- Empty state -->
      <div v-else-if="messages.length === 0 && !loading" class="sb-card">
        <div class="sb-empty">
          <p>{{ t('admin.federation.dlq.empty') }}</p>
        </div>
      </div>

      <!-- Message table -->
      <div v-else class="sb-card overflow-hidden">
        <div class="max-h-[70vh] overflow-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left">
                <th v-if="statusFilter === 'parked'" class="sticky top-0 z-10 w-12 border-b border-outline bg-surface-2 px-4 py-3 dark:border-outline-dark dark:bg-surface-2-dark">
                  <input
                    type="checkbox"
                    :checked="allVisibleSelected"
                    :aria-label="t('admin.federation.dlq.select_all_visible')"
                    :disabled="actionBusy"
                    class="h-4 w-4 rounded border-outline text-brand-600"
                    @change="toggleAllVisible"
                  />
                </th>
                <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400">{{ t('admin.federation.dlq.activity') }}</th>
                <th class="sticky top-0 z-10 hidden border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400 md:table-cell">{{ t('admin.federation.dlq.error') }}</th>
                <th class="sticky top-0 z-10 hidden border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400 lg:table-cell">{{ t('admin.federation.dlq.attempts') }}</th>
                <th class="sticky top-0 z-10 hidden border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400 sm:table-cell">{{ t('admin.federation.dlq.parked_at') }}</th>
                <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="msg in messages" :key="msg.id">
                <tr
                  class="cursor-pointer border-b border-outline transition-colors last:border-0 hover:bg-surface-2/70 dark:border-outline-dark dark:hover:bg-surface-2-dark/70"
                  @click="toggleExpand(msg.id)"
                >
                  <td v-if="statusFilter === 'parked'" class="px-4 py-3" @click.stop>
                    <input
                      type="checkbox"
                      :checked="selectedIds.has(msg.id)"
                      :aria-label="t('admin.federation.dlq.select_message', { activity: activityLabel(msg) })"
                      :disabled="actionBusy"
                      class="h-4 w-4 rounded border-outline text-brand-600"
                      @change="toggleSelection(msg.id)"
                    />
                  </td>
                  <td class="px-4 py-3">
                    <div class="font-medium text-slate-900 dark:text-white">{{ activityLabel(msg) }}</div>
                    <div v-if="msg.actor" class="mt-0.5 max-w-[16rem] truncate text-xs text-slate-500 dark:text-slate-400">{{ msg.actor }}</div>
                  </td>
                  <td class="hidden max-w-[24rem] px-4 py-3 md:table-cell">
                    <span class="line-clamp-2 break-all text-slate-600 dark:text-slate-400">{{ errorSummary(msg) }}</span>
                  </td>
                  <td class="hidden px-4 py-3 text-slate-600 dark:text-slate-400 lg:table-cell">
                    {{ msg.attempts }}
                  </td>
                  <td class="hidden px-4 py-3 text-slate-600 dark:text-slate-400 sm:table-cell">
                    {{ formatDateTime(msg.parked_at) }}
                  </td>
                  <td class="px-4 py-3">
                    <div v-if="msg.status === 'parked'" class="flex justify-end gap-1" @click.stop>
                      <button
                        :disabled="bulkBusy || busyId === msg.id"
                        class="sb-btn sb-btn-ghost sb-btn-sm shrink-0 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-300"
                        @click="replay(msg)"
                      >
                        {{ t('admin.federation.dlq.replay') }}
                      </button>
                      <button
                        :disabled="bulkBusy || busyId === msg.id"
                        class="sb-btn sb-btn-ghost sb-btn-sm shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                        @click="discard(msg)"
                      >
                        {{ t('admin.federation.dlq.discard') }}
                      </button>
                    </div>
                    <span v-else class="sb-chip float-right" :class="statusChipClasses(msg.status)">
                      {{ t(`admin.federation.dlq.${msg.status}`) }}
                    </span>
                  </td>
                </tr>
                <!-- Expanded detail panel -->
                <tr v-if="expandedId === msg.id" class="border-b border-outline last:border-0 dark:border-outline-dark">
                  <td :colspan="statusFilter === 'parked' ? 6 : 5" class="px-4 pb-4 pt-1">
                    <div class="space-y-3 rounded-xl border border-outline bg-surface-2 p-4 text-sm dark:border-outline-dark dark:bg-surface-2-dark">
                      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div>
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.dlq.message_type') }}:</span>
                          <span class="ml-2 text-slate-900 dark:text-white">{{ msg.message_type ?? '-' }}</span>
                        </div>
                        <div>
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.dlq.attempts') }}:</span>
                          <span class="ml-2 text-slate-900 dark:text-white">{{ msg.attempts }}</span>
                        </div>
                        <div class="sm:col-span-2">
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.dlq.activity') }}:</span>
                          <span class="ml-2 break-all text-slate-900 dark:text-white">{{ msg.activity_id ?? '-' }}</span>
                        </div>
                        <div class="sm:col-span-2">
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.dlq.actor') }}:</span>
                          <span class="ml-2 break-all text-slate-900 dark:text-white">{{ msg.actor ?? '-' }}</span>
                        </div>
                      </div>
                      <div v-if="msg.error">
                        <div class="mb-1 font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.dlq.error') }}</div>
                        <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">{{ msg.error }}</pre>
                      </div>
                      <div>
                        <div class="mb-1 font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.dlq.body') }}</div>
                        <pre class="max-h-72 overflow-auto rounded-lg bg-surface p-3 text-xs text-slate-700 dark:bg-surface-dark dark:text-slate-300">{{ prettyBody(msg) }}</pre>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Load more -->
      <div v-if="hasMore && messages.length > 0" class="mt-4 text-center">
        <button
          :disabled="loading"
          class="sb-btn sb-btn-secondary"
          @click="load(true)"
        >
          {{ loading ? t('common.loading') : t('common.load_more') }}
        </button>
      </div>
    </div>
  </DeckAdminLayout>
</template>
