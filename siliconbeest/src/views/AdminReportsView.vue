<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import AdminLayout from '@/components/layout/AdminLayout.vue'
import type { Account, Status } from '@/types/mastodon'

interface AdminReport {
  id: string
  action_taken: boolean
  action_taken_at: string | null
  category: string
  comment: string
  forwarded: boolean
  created_at: string
  updated_at: string
  account: Account
  target_account: Account
  assigned_account: Account | null
  statuses: Status[]
}

const { t } = useI18n()
const authStore = useAuthStore()

const loading = ref(false)
const error = ref<string | null>(null)
const reports = ref<AdminReport[]>([])
const filter = ref<'unresolved' | 'resolved'>('unresolved')

onMounted(() => {
  loadReports()
})

const filteredReports = computed(() => {
  return reports.value.filter((r) => {
    if (filter.value === 'resolved') return r.action_taken
    return !r.action_taken
  })
})

async function loadReports() {
  loading.value = true
  error.value = null
  try {
    const { data } = await apiFetch<AdminReport[]>('/v1/admin/reports', {
      token: authStore.token ?? undefined,
    })
    reports.value = data
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function resolveReport(id: string) {
  try {
    await apiFetch(`/v1/admin/reports/${id}/resolve`, {
      method: 'POST',
      token: authStore.token ?? undefined,
    })
    await loadReports()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function assignToSelf(id: string) {
  try {
    await apiFetch(`/v1/admin/reports/${id}/assign_to_self`, {
      method: 'POST',
      token: authStore.token ?? undefined,
    })
    await loadReports()
  } catch (e) {
    error.value = (e as Error).message
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
</script>

<template>
  <AdminLayout>
  <div class="w-full">
    <h1 class="text-2xl font-bold mb-6 text-gray-900 dark:text-white">{{ t('admin.reports') }}</h1>

    <!-- Filter tabs -->
    <div class="flex gap-2 mb-6">
      <button
        class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        :class="
          filter === 'unresolved'
            ? 'bg-indigo-600 text-white'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
        "
        @click="filter = 'unresolved'"
      >
        {{ t('admin.reportStatus.open') }}
      </button>
      <button
        class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        :class="
          filter === 'resolved'
            ? 'bg-indigo-600 text-white'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
        "
        @click="filter = 'resolved'"
      >
        {{ t('admin.reportStatus.resolved') }}
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
      {{ error }}
    </div>

    <LoadingSpinner v-if="loading" />

    <div v-else-if="filteredReports.length === 0" class="text-center py-12 text-gray-500 dark:text-gray-400">
      <p>{{ t('admin.noReports') }}</p>
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="report in filteredReports"
        :key="report.id"
        class="p-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      >
        <div class="flex items-start justify-between mb-3">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="text-sm font-medium text-gray-900 dark:text-white">
                #{{ report.id }}
              </span>
              <span
                class="px-2 py-0.5 rounded-full text-xs font-medium"
                :class="
                  report.action_taken
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                "
              >
                {{ report.action_taken ? t('admin.reportStatus.resolved') : t('admin.reportStatus.open') }}
              </span>
              <span v-if="report.category" class="px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                {{ report.category }}
              </span>
            </div>
            <p class="text-sm text-gray-500 dark:text-gray-400">
              {{ t('admin.reportedBy') }} <span class="font-medium text-gray-700 dark:text-gray-300">@{{ report.account.acct }}</span>
            </p>
            <p class="text-sm text-gray-500 dark:text-gray-400">
              {{ t('admin.reportTarget') }} <span class="font-medium text-gray-700 dark:text-gray-300">@{{ report.target_account.acct }}</span>
            </p>
          </div>
          <span class="text-xs text-gray-400">{{ formatDate(report.created_at) }}</span>
        </div>

        <p v-if="report.comment" class="text-sm text-gray-700 dark:text-gray-300 mb-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-900/50">
          {{ report.comment }}
        </p>

        <div v-if="report.statuses.length > 0" class="mb-3">
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            {{ t('admin.reportedStatuses', { count: report.statuses.length }) }}
          </p>
        </div>

        <div v-if="!report.action_taken" class="flex gap-2">
          <button
            class="px-3 py-1.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors"
            @click="resolveReport(report.id)"
          >
            {{ t('admin.resolveReport') }}
          </button>
          <button
            class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            @click="assignToSelf(report.id)"
          >
            {{ t('admin.assignToSelf') }}
          </button>
        </div>
      </div>
    </div>
  </div>
  </AdminLayout>
</template>
