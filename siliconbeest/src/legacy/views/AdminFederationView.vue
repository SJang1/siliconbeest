<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import {
  getFederationInstances,
  getFederationStats,
  refreshFederationInstance,
  diagnoseFederationInstance,
  resetFederationInstanceCache,
  setFederationInstanceSuspended,
  deleteFederationInstance,
  type FederationInstance,
  type FederationDiagnostics,
  type FederationStats,
} from '@/api/mastodon/admin'
import AdminLayout from '@/legacy/components/layout/AdminLayout.vue'
import LoadingSpinner from '@/legacy/components/common/LoadingSpinner.vue'

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
      classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    }
  }
  const failureCount = instance.failure_count
  if (failureCount === 0) {
    return {
      label: t('admin.federation.healthy'),
      classes: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    }
  }
  if (failureCount <= 3) {
    return {
      label: t('admin.federation.degraded'),
      classes: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    }
  }
  return {
    label: t('admin.federation.down'),
    classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
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
  loadInstances()
})
</script>

<template>
  <AdminLayout>
    <div class="w-full">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-6">
        {{ t('admin.federation.title') }}
      </h1>

      <!-- Stats cards -->
      <div v-if="stats" class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div class="text-2xl font-bold text-gray-900 dark:text-white">{{ stats.total }}</div>
          <div class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.federation.total') }}</div>
        </div>
        <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div class="text-2xl font-bold text-green-600 dark:text-green-400">{{ stats.active }}</div>
          <div class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.federation.active') }}</div>
        </div>
        <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div class="text-2xl font-bold text-red-600 dark:text-red-400">{{ stats.unreachable }}</div>
          <div class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.federation.unreachable') }}</div>
        </div>
        <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{{ stats.remote_accounts }}</div>
          <div class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.federation.remote_accounts') }}</div>
        </div>
      </div>

      <!-- Search -->
      <div class="mb-4">
        <input
          v-model="searchQuery"
          type="text"
          :placeholder="t('admin.federation.search_placeholder')"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          @input="onSearchInput"
        />
      </div>

      <!-- Error -->
      <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
        {{ error }}
      </div>
      <div v-if="success" class="mb-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
        {{ success }}
      </div>

      <LoadingSpinner v-if="loading && instances.length === 0" />

      <!-- Empty state -->
      <div v-else-if="filteredInstances.length === 0 && !loading" class="text-center py-12 text-gray-500 dark:text-gray-400">
        <p>{{ t('admin.federation.no_instances') }}</p>
      </div>

      <!-- Instance table -->
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-200 dark:border-gray-700 text-left">
              <th class="pb-2 font-medium text-gray-500 dark:text-gray-400">{{ t('admin.domain') }}</th>
              <th class="pb-2 font-medium text-gray-500 dark:text-gray-400 hidden sm:table-cell">{{ t('admin.federation.software') }}</th>
              <th class="pb-2 font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">{{ t('admin.federation.accounts') }}</th>
              <th class="pb-2 font-medium text-gray-500 dark:text-gray-400 hidden lg:table-cell">{{ t('admin.federation.last_active') }}</th>
              <th class="pb-2 font-medium text-gray-500 dark:text-gray-400">{{ t('admin.federation.status') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="instance in filteredInstances" :key="instance.domain">
              <tr
                class="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors"
                @click="toggleExpand(instance.domain)"
              >
                <td class="py-3 pr-4">
                  <span class="font-medium text-gray-900 dark:text-white">{{ instance.domain }}</span>
                </td>
                <td class="py-3 pr-4 text-gray-600 dark:text-gray-400 hidden sm:table-cell">
                  {{ instance.software ?? '-' }}
                </td>
                <td class="py-3 pr-4 text-gray-600 dark:text-gray-400 hidden md:table-cell">
                  {{ instance.account_count }}
                </td>
                <td class="py-3 pr-4 text-gray-600 dark:text-gray-400 hidden lg:table-cell">
                  {{ formatDate(instance.last_successful_at) }}
                </td>
                <td class="py-3">
                  <span
                    class="px-2 py-0.5 rounded-full text-xs font-medium"
                    :class="statusBadge(instance).classes"
                  >
                    {{ statusBadge(instance).label }}
                  </span>
                </td>
              </tr>
              <!-- Expanded detail panel -->
              <tr v-if="expandedDomain === instance.domain">
                <td colspan="5" class="pb-4 pt-1">
                  <div class="p-4 rounded-lg bg-gray-50 dark:bg-gray-800/70 border border-gray-200 dark:border-gray-700 space-y-2 text-sm">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <span class="font-medium text-gray-500 dark:text-gray-400">{{ t('admin.domain') }}:</span>
                        <span class="ml-2 text-gray-900 dark:text-white">{{ instance.domain }}</span>
                      </div>
                      <div>
                        <span class="font-medium text-gray-500 dark:text-gray-400">{{ t('admin.federation.software') }}:</span>
                        <span class="ml-2 text-gray-900 dark:text-white">{{ instance.software ?? '-' }} {{ instance.version ?? '' }}</span>
                      </div>
                      <div>
                        <span class="font-medium text-gray-500 dark:text-gray-400">{{ t('admin.federation.accounts') }}:</span>
                        <span class="ml-2 text-gray-900 dark:text-white">{{ instance.account_count }}</span>
                      </div>
                      <div>
                        <span class="font-medium text-gray-500 dark:text-gray-400">{{ t('admin.federation.registrations') }}:</span>
                        <span class="ml-2 text-gray-900 dark:text-white">
                          {{ instance.open_registrations === null ? '-' : instance.open_registrations ? 'Yes' : 'No' }}
                        </span>
                      </div>
                      <div>
                        <span class="font-medium text-gray-500 dark:text-gray-400">{{ t('admin.federation.first_seen') }}:</span>
                        <span class="ml-2 text-gray-900 dark:text-white">{{ formatDate(instance.created_at) }}</span>
                      </div>
                      <div>
                        <span class="font-medium text-gray-500 dark:text-gray-400">{{ t('admin.federation.last_active') }}:</span>
                        <span class="ml-2 text-gray-900 dark:text-white">{{ formatDate(instance.last_successful_at) }}</span>
                      </div>
                    </div>
                    <div v-if="instance.description">
                      <span class="font-medium text-gray-500 dark:text-gray-400">{{ t('admin.federation.description') }}:</span>
                      <p class="mt-1 text-gray-700 dark:text-gray-300">{{ instance.description }}</p>
                    </div>
                    <div class="flex flex-wrap gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
                      <button
                        class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-xs hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                        :disabled="busyAction !== null || instance.suspended"
                        @click.stop="refreshRemote(instance)"
                      >
                        {{ t('admin.federation.actions.refresh') }}
                      </button>
                      <button
                        v-if="instance.suspended"
                        class="px-3 py-1.5 rounded-lg border border-green-300 dark:border-green-700 text-green-700 dark:text-green-400 text-xs hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors disabled:opacity-50"
                        :disabled="busyAction !== null"
                        @click.stop="setSuspended(instance, false)"
                      >
                        {{ t('admin.federation.actions.resume') }}
                      </button>
                      <button
                        v-else
                        class="px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 text-xs hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                        :disabled="busyAction !== null"
                        @click.stop="setSuspended(instance, true)"
                      >
                        {{ t('admin.federation.actions.suspend') }}
                      </button>
                      <button
                        class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-xs hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                        :disabled="busyAction !== null"
                        @click.stop="runDiagnosis(instance)"
                      >
                        {{ t('admin.federation.actions.diagnose') }}
                      </button>
                      <button
                        class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-xs hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                        :disabled="busyAction !== null"
                        @click.stop="resetRemoteCache(instance)"
                      >
                        {{ t('admin.federation.actions.reset_cache') }}
                      </button>
                      <button
                        class="px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 text-xs hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                        :disabled="busyAction !== null"
                        @click.stop="deleteRecord(instance)"
                      >
                        {{ t('admin.federation.actions.delete_record') }}
                      </button>
                    </div>
                    <div
                      v-if="diagnosis?.domain === instance.domain"
                      class="space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700"
                    >
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <span class="font-semibold text-gray-900 dark:text-white">
                          {{ t('admin.federation.actions.diagnostics_title') }}
                        </span>
                        <span class="text-xs text-gray-500 dark:text-gray-400">
                          {{ t('admin.federation.actions.diagnostics_checked_at') }}: {{ formatDateTime(diagnosis.checked_at) }}
                        </span>
                      </div>
                      <div class="grid gap-2 sm:grid-cols-3">
                        <div
                          v-for="checkName in DIAGNOSTIC_CHECKS"
                          :key="checkName"
                          class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
                        >
                          <div class="flex items-center justify-between gap-2">
                            <span class="font-medium text-gray-700 dark:text-gray-300">
                              {{ t(`admin.federation.actions.diagnostics_${checkName}`) }}
                            </span>
                            <span
                              class="px-2 py-0.5 rounded-full text-xs font-medium"
                              :class="diagnosis.checks[checkName].ok
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'"
                            >
                              {{ t(diagnosis.checks[checkName].ok
                                ? 'admin.federation.actions.diagnostics_ok'
                                : 'admin.federation.actions.diagnostics_failed') }}
                            </span>
                          </div>
                          <p v-if="diagnosis.checks[checkName].detail" class="mt-2 break-all text-xs text-gray-600 dark:text-gray-400">
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

      <!-- Load more -->
      <div v-if="hasMore && filteredInstances.length > 0" class="mt-4 text-center">
        <button
          :disabled="loading"
          class="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          @click="loadMore"
        >
          {{ loading ? t('common.loading') : t('common.next') }}
        </button>
      </div>
    </div>
  </AdminLayout>
</template>
