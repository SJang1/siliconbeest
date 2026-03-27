<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import {
  getFederationInstances,
  getFederationStats,
  type FederationInstance,
  type FederationStats,
} from '@/api/mastodon/admin'
import AdminLayout from '@/components/layout/AdminLayout.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const auth = useAuthStore()

const loading = ref(false)
const error = ref<string | null>(null)
const instances = ref<FederationInstance[]>([])
const stats = ref<FederationStats | null>(null)
const searchQuery = ref('')
const expandedDomain = ref<string | null>(null)
const hasMore = ref(true)
const offset = ref(0)
const LIMIT = 50

const filteredInstances = computed(() => {
  if (!searchQuery.value.trim()) return instances.value
  const q = searchQuery.value.toLowerCase()
  return instances.value.filter((i) => i.domain.toLowerCase().includes(q))
})

function statusBadge(failureCount: number): { label: string; classes: string } {
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

function toggleExpand(domain: string) {
  expandedDomain.value = expandedDomain.value === domain ? null : domain
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
                    :class="statusBadge(instance.failure_count).classes"
                  >
                    {{ statusBadge(instance.failure_count).label }}
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
