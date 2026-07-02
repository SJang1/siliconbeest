<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
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
const router = useRouter()
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

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function categoryBadgeClass(category: string) {
  switch (category) {
    case 'spam': return 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
    case 'violation': return 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
    case 'legal': return 'bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300'
    default: return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
  }
}

function goToReport(id: string) {
  router.push('/admin/reports/' + id)
}
</script>

<template>
  <AdminLayout>
  <div class="w-full max-w-5xl animate-fade-in">
    <h1 class="sb-heading mb-6 text-2xl text-slate-900 dark:text-white">{{ t('admin.reports') }}</h1>

    <!-- Filter tabs -->
    <div class="mb-6 inline-flex gap-1 rounded-full border border-outline bg-surface p-1 shadow-soft dark:border-outline-dark dark:bg-surface-dark">
      <button
        class="rounded-full px-4 py-1.5 text-sm font-medium transition-colors"
        :class="
          filter === 'unresolved'
            ? 'bg-brand-600 text-white shadow-soft dark:bg-brand-500'
            : 'text-slate-600 hover:bg-surface-2 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-surface-2-dark dark:hover:text-white'
        "
        @click="filter = 'unresolved'"
      >
        {{ t('admin.reportStatus.open') }}
      </button>
      <button
        class="rounded-full px-4 py-1.5 text-sm font-medium transition-colors"
        :class="
          filter === 'resolved'
            ? 'bg-brand-600 text-white shadow-soft dark:bg-brand-500'
            : 'text-slate-600 hover:bg-surface-2 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-surface-2-dark dark:hover:text-white'
        "
        @click="filter = 'resolved'"
      >
        {{ t('admin.reportStatus.resolved') }}
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
      {{ error }}
    </div>

    <LoadingSpinner v-if="loading" />

    <div v-else-if="filteredReports.length === 0" class="sb-card">
      <div class="sb-empty">
        <p>{{ t('admin.noReports') }}</p>
      </div>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="report in filteredReports"
        :key="report.id"
        class="sb-card sb-card-hover cursor-pointer p-4"
        @click="goToReport(report.id)"
      >
        <div class="flex items-center justify-between">
          <div class="flex min-w-0 items-center gap-2">
            <span class="shrink-0 text-sm font-semibold text-slate-900 dark:text-white">
              #{{ report.id }}
            </span>
            <span
              v-if="report.category"
              class="sb-chip shrink-0"
              :class="categoryBadgeClass(report.category)"
            >
              {{ t('admin.reportDetail.category_' + report.category) }}
            </span>
            <span
              class="sb-chip shrink-0"
              :class="
                report.action_taken
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                  : 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
              "
            >
              {{ report.action_taken ? t('admin.reportStatus.resolved') : t('admin.reportStatus.open') }}
            </span>
          </div>
          <span class="ml-3 shrink-0 text-xs text-slate-400 dark:text-slate-500">{{ formatDate(report.created_at) }}</span>
        </div>
        <div class="mt-2 flex items-center gap-4 text-sm text-slate-500 dark:text-slate-400">
          <span>
            {{ t('admin.reportTarget') }}: <span class="font-medium text-slate-700 dark:text-slate-300">@{{ report.target_account.acct }}</span>
          </span>
          <span>
            {{ t('admin.reportedBy') }}: <span class="font-medium text-slate-700 dark:text-slate-300">@{{ report.account.acct }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
  </AdminLayout>
</template>
