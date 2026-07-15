<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import {
  getFederationInstances,
  getFederationStats,
  getFederationDlq,
  refreshFederationInstance,
  diagnoseFederationInstance,
  resetFederationInstanceCache,
  setFederationInstanceSuspended,
  deleteFederationInstance,
  type FederationInstance,
  type FederationDiagnostics,
  type FederationStats,
} from '@/api/mastodon/admin'
import DeckAdminLayout from '@/deck/layout/DeckAdminLayout.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const auth = useAuthStore()

const loading = ref(false)
const error = ref<string | null>(null)
const success = ref<string | null>(null)
const instances = ref<FederationInstance[]>([])
const stats = ref<FederationStats | null>(null)
const searchQuery = ref('')
const expandedDomain = ref<string | null>(null)
const diagnosis = ref<FederationDiagnostics | null>(null)
const busyAction = ref<{ domain: string; action: FederationAction } | null>(null)
const hasMore = ref(true)
const offset = ref(0)
const LIMIT = 50
const DIAGNOSTIC_CHECKS = ['nodeinfo', 'actor', 'delivery'] as const

type FederationAction = 'refresh' | 'suspend' | 'resume' | 'diagnose' | 'reset-cache' | 'delete'

const filteredInstances = computed(() => {
  if (!searchQuery.value.trim()) return instances.value
  const q = searchQuery.value.toLowerCase()
  return instances.value.filter((i) => i.domain.toLowerCase().includes(q))
})

function statusBadge(instance: FederationInstance): { label: string; classes: string } {
  if (instance.suspended) {
    return {
      label: t('admin.federation.actions.suspended'),
      classes: 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300',
    }
  }
  const failureCount = instance.failure_count
  if (failureCount === 0) {
    return {
      label: t('admin.federation.healthy'),
      classes: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
    }
  }
  if (failureCount <= 3) {
    return {
      label: t('admin.federation.degraded'),
      classes: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
    }
  }
  return {
    label: t('admin.federation.down'),
    classes: 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString()
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

function toggleExpand(domain: string) {
  if (diagnosis.value?.domain !== domain) diagnosis.value = null
  expandedDomain.value = expandedDomain.value === domain ? null : domain
}

function startAction(domain: string, action: FederationAction): boolean {
  if (busyAction.value) return false
  busyAction.value = { domain, action }
  error.value = null
  success.value = null
  return true
}

function finishAction() {
  busyAction.value = null
}

async function refreshRemote(instance: FederationInstance) {
  if (!startAction(instance.domain, 'refresh')) return
  try {
    await refreshFederationInstance(auth.token!, instance.domain)
    success.value = t('admin.federation.actions.refresh_queued', { domain: instance.domain })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    finishAction()
  }
}

async function setSuspended(instance: FederationInstance, suspended: boolean) {
  if (suspended && !confirm(t('admin.federation.actions.suspend_confirm', { domain: instance.domain }))) return
  const action: FederationAction = suspended ? 'suspend' : 'resume'
  if (!startAction(instance.domain, action)) return
  try {
    const res = await setFederationInstanceSuspended(auth.token!, instance.domain, suspended)
    instance.suspended = res.data.suspended
    success.value = t(
      suspended ? 'admin.federation.actions.suspend_success' : 'admin.federation.actions.resume_success',
      { domain: instance.domain },
    )
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    finishAction()
  }
}

async function runDiagnosis(instance: FederationInstance) {
  if (!startAction(instance.domain, 'diagnose')) return
  diagnosis.value = null
  try {
    const res = await diagnoseFederationInstance(auth.token!, instance.domain)
    diagnosis.value = res.data
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    finishAction()
  }
}

async function resetRemoteCache(instance: FederationInstance) {
  if (!confirm(t('admin.federation.actions.reset_cache_confirm', { domain: instance.domain }))) return
  if (!startAction(instance.domain, 'reset-cache')) return
  try {
    await resetFederationInstanceCache(auth.token!, instance.domain)
    success.value = t('admin.federation.actions.reset_cache_queued', { domain: instance.domain })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    finishAction()
  }
}

async function deleteRecord(instance: FederationInstance) {
  if (!confirm(t('admin.federation.actions.delete_record_confirm', { domain: instance.domain }))) return
  if (!startAction(instance.domain, 'delete')) return
  try {
    await deleteFederationInstance(auth.token!, instance.domain)
    instances.value = instances.value.filter((item) => item.domain !== instance.domain)
    offset.value = instances.value.length
    expandedDomain.value = null
    if (diagnosis.value?.domain === instance.domain) diagnosis.value = null
    success.value = t('admin.federation.actions.delete_record_success', { domain: instance.domain })
    await loadStats()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    finishAction()
  }
}

async function loadStats() {
  try {
    const res = await getFederationStats(auth.token!)
    stats.value = res.data
  } catch {
    // Stats are optional, don't block the view
  }
}

const dlqParkedCount = ref(0)

async function loadDlqCount() {
  try {
    const res = await getFederationDlq(auth.token!, { limit: '1' })
    dlqParkedCount.value = res.data.counts.parked ?? 0
  } catch {
    // DLQ count is optional, don't block the view
  }
}

async function loadInstances(append = false) {
  loading.value = true
  error.value = null
  try {
    const params: Record<string, string> = { limit: String(LIMIT) }
    if (append && instances.value.length > 0) {
      params.offset = String(offset.value)
    }
    if (searchQuery.value.trim()) {
      params.search = searchQuery.value.trim()
    }
    const res = await getFederationInstances(auth.token!, params)
    if (append) {
      instances.value = [...instances.value, ...res.data]
    } else {
      instances.value = res.data
    }
    hasMore.value = res.data.length >= LIMIT
    offset.value = instances.value.length
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function loadMore() {
  loadInstances(true)
}

let searchTimeout: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimeout) clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    offset.value = 0
    loadInstances(false)
  }, 300)
}

onMounted(() => {
  loadStats()
  loadDlqCount()
  loadInstances()
})
</script>

<template>
  <DeckAdminLayout>
    <div class="w-full max-w-6xl animate-fade-in">
      <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 class="sb-heading text-2xl text-slate-900 dark:text-white">
          {{ t('admin.federation.title') }}
        </h1>
        <router-link to="/admin/federation-dlq" class="sb-btn sb-btn-secondary no-underline">
          {{ t('admin.federation.dlq.link') }}
          <span
            v-if="dlqParkedCount > 0"
            class="sb-chip ml-1.5 bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
          >
            {{ dlqParkedCount }}
          </span>
        </router-link>
      </div>

      <!-- Stats cards -->
      <div v-if="stats" class="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div class="sb-card p-4">
          <div class="sb-heading text-2xl text-slate-900 dark:text-white">{{ stats.total }}</div>
          <div class="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{{ t('admin.federation.total') }}</div>
        </div>
        <div class="sb-card p-4">
          <div class="sb-heading text-2xl text-emerald-600 dark:text-emerald-400">{{ stats.active }}</div>
          <div class="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{{ t('admin.federation.active') }}</div>
        </div>
        <div class="sb-card p-4">
          <div class="sb-heading text-2xl text-red-600 dark:text-red-400">{{ stats.unreachable }}</div>
          <div class="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{{ t('admin.federation.unreachable') }}</div>
        </div>
        <div class="sb-card p-4">
          <div class="sb-heading text-2xl text-brand-600 dark:text-brand-400">{{ stats.remote_accounts }}</div>
          <div class="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{{ t('admin.federation.remote_accounts') }}</div>
        </div>
      </div>

      <!-- Search -->
      <div class="mb-4">
        <input
          v-model="searchQuery"
          type="text"
          :placeholder="t('admin.federation.search_placeholder')"
          class="sb-input"
          @input="onSearchInput"
        />
      </div>

      <!-- Error -->
      <div v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
        {{ error }}
      </div>
      <div v-if="success" class="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
        {{ success }}
      </div>

      <LoadingSpinner v-if="loading && instances.length === 0" />

      <!-- Empty state -->
      <div v-else-if="filteredInstances.length === 0 && !loading" class="sb-card">
        <div class="sb-empty">
          <p>{{ t('admin.federation.no_instances') }}</p>
        </div>
      </div>

      <!-- Instance table -->
      <div v-else class="sb-card overflow-hidden">
        <div class="max-h-[70vh] overflow-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left">
                <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400">{{ t('admin.domain') }}</th>
                <th class="sticky top-0 z-10 hidden border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400 sm:table-cell">{{ t('admin.federation.software') }}</th>
                <th class="sticky top-0 z-10 hidden border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400 md:table-cell">{{ t('admin.federation.accounts') }}</th>
                <th class="sticky top-0 z-10 hidden border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400 lg:table-cell">{{ t('admin.federation.last_active') }}</th>
                <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400">{{ t('admin.federation.status') }}</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="instance in filteredInstances" :key="instance.domain">
                <tr
                  class="cursor-pointer border-b border-outline transition-colors last:border-0 hover:bg-surface-2/70 dark:border-outline-dark dark:hover:bg-surface-2-dark/70"
                  @click="toggleExpand(instance.domain)"
                >
                  <td class="px-4 py-3">
                    <span class="font-medium text-slate-900 dark:text-white">{{ instance.domain }}</span>
                  </td>
                  <td class="hidden px-4 py-3 text-slate-600 dark:text-slate-400 sm:table-cell">
                    {{ instance.software ?? '-' }}
                  </td>
                  <td class="hidden px-4 py-3 text-slate-600 dark:text-slate-400 md:table-cell">
                    {{ instance.account_count }}
                  </td>
                  <td class="hidden px-4 py-3 text-slate-600 dark:text-slate-400 lg:table-cell">
                    {{ formatDate(instance.last_successful_at) }}
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class="sb-chip"
                      :class="statusBadge(instance).classes"
                    >
                      {{ statusBadge(instance).label }}
                    </span>
                  </td>
                </tr>
                <!-- Expanded detail panel -->
                <tr v-if="expandedDomain === instance.domain" class="border-b border-outline last:border-0 dark:border-outline-dark">
                  <td colspan="5" class="px-4 pb-4 pt-1">
                    <div class="space-y-2 rounded-xl border border-outline bg-surface-2 p-4 text-sm dark:border-outline-dark dark:bg-surface-2-dark">
                      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div>
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.domain') }}:</span>
                          <span class="ml-2 text-slate-900 dark:text-white">{{ instance.domain }}</span>
                        </div>
                        <div>
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.software') }}:</span>
                          <span class="ml-2 text-slate-900 dark:text-white">{{ instance.software ?? '-' }} {{ instance.version ?? '' }}</span>
                        </div>
                        <div>
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.accounts') }}:</span>
                          <span class="ml-2 text-slate-900 dark:text-white">{{ instance.account_count }}</span>
                        </div>
                        <div>
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.registrations') }}:</span>
                          <span class="ml-2 text-slate-900 dark:text-white">
                            {{ instance.open_registrations === null ? '-' : instance.open_registrations ? 'Yes' : 'No' }}
                          </span>
                        </div>
                        <div>
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.first_seen') }}:</span>
                          <span class="ml-2 text-slate-900 dark:text-white">{{ formatDate(instance.created_at) }}</span>
                        </div>
                        <div>
                          <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.last_active') }}:</span>
                          <span class="ml-2 text-slate-900 dark:text-white">{{ formatDate(instance.last_successful_at) }}</span>
                        </div>
                      </div>
                      <div v-if="instance.description">
                        <span class="font-medium text-slate-500 dark:text-slate-400">{{ t('admin.federation.description') }}:</span>
                        <p class="mt-1 text-slate-700 dark:text-slate-300">{{ instance.description }}</p>
                      </div>
                      <div class="flex flex-wrap gap-2 border-t border-outline pt-3 dark:border-outline-dark">
                        <button
                          class="sb-btn sb-btn-secondary sb-btn-sm"
                          :disabled="busyAction !== null || instance.suspended"
                          @click.stop="refreshRemote(instance)"
                        >
                          {{ t('admin.federation.actions.refresh') }}
                        </button>
                        <button
                          v-if="instance.suspended"
                          class="sb-btn sb-btn-secondary sb-btn-sm text-emerald-700 dark:text-emerald-300"
                          :disabled="busyAction !== null"
                          @click.stop="setSuspended(instance, false)"
                        >
                          {{ t('admin.federation.actions.resume') }}
                        </button>
                        <button
                          v-else
                          class="sb-btn sb-btn-danger sb-btn-sm"
                          :disabled="busyAction !== null"
                          @click.stop="setSuspended(instance, true)"
                        >
                          {{ t('admin.federation.actions.suspend') }}
                        </button>
                        <button
                          class="sb-btn sb-btn-secondary sb-btn-sm"
                          :disabled="busyAction !== null"
                          @click.stop="runDiagnosis(instance)"
                        >
                          {{ t('admin.federation.actions.diagnose') }}
                        </button>
                        <button
                          class="sb-btn sb-btn-secondary sb-btn-sm"
                          :disabled="busyAction !== null"
                          @click.stop="resetRemoteCache(instance)"
                        >
                          {{ t('admin.federation.actions.reset_cache') }}
                        </button>
                        <button
                          class="sb-btn sb-btn-danger sb-btn-sm"
                          :disabled="busyAction !== null"
                          @click.stop="deleteRecord(instance)"
                        >
                          {{ t('admin.federation.actions.delete_record') }}
                        </button>
                      </div>
                      <div
                        v-if="diagnosis?.domain === instance.domain"
                        class="space-y-3 border-t border-outline pt-3 dark:border-outline-dark"
                      >
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <span class="font-semibold text-slate-900 dark:text-white">
                            {{ t('admin.federation.actions.diagnostics_title') }}
                          </span>
                          <span class="text-xs text-slate-500 dark:text-slate-400">
                            {{ t('admin.federation.actions.diagnostics_checked_at') }}: {{ formatDateTime(diagnosis.checked_at) }}
                          </span>
                        </div>
                        <div class="grid gap-2 sm:grid-cols-3">
                          <div
                            v-for="checkName in DIAGNOSTIC_CHECKS"
                            :key="checkName"
                            class="rounded-lg border border-outline bg-surface p-3 dark:border-outline-dark dark:bg-surface-dark"
                          >
                            <div class="flex items-center justify-between gap-2">
                              <span class="font-medium text-slate-700 dark:text-slate-300">
                                {{ t(`admin.federation.actions.diagnostics_${checkName}`) }}
                              </span>
                              <span
                                class="sb-chip"
                                :class="diagnosis.checks[checkName].ok
                                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                                  : 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'"
                              >
                                {{ t(diagnosis.checks[checkName].ok
                                  ? 'admin.federation.actions.diagnostics_ok'
                                  : 'admin.federation.actions.diagnostics_failed') }}
                              </span>
                            </div>
                            <p v-if="diagnosis.checks[checkName].detail" class="mt-2 break-all text-xs text-slate-600 dark:text-slate-400">
                              {{ diagnosis.checks[checkName].detail }}
                            </p>
                            <p v-if="diagnosis.checks[checkName].error" class="mt-2 break-all text-xs text-red-600 dark:text-red-400">
                              {{ diagnosis.checks[checkName].error }}
                            </p>
                          </div>
                        </div>
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
      <div v-if="hasMore && filteredInstances.length > 0" class="mt-4 text-center">
        <button
          :disabled="loading"
          class="sb-btn sb-btn-secondary"
          @click="loadMore"
        >
          {{ loading ? t('common.loading') : t('common.next') }}
        </button>
      </div>
    </div>
  </DeckAdminLayout>
</template>
