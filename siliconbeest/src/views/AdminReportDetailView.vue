<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
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

interface AccountWarning {
  id: string
  action: string
  text: string
  created_at: string
}

const props = defineProps<{ id: string }>()

const { t } = useI18n()
const router = useRouter()
const authStore = useAuthStore()

const loading = ref(true)
const error = ref<string | null>(null)
const report = ref<AdminReport | null>(null)
const warnings = ref<AccountWarning[]>([])
const submitting = ref(false)

// Action form state
const actionType = ref('none')
const actionText = ref('')
const sendEmail = ref(true)

const actionTypes = [
  { value: 'none', labelKey: 'admin.reportDetail.actionNone' },
  { value: 'warn', labelKey: 'admin.reportDetail.actionWarn' },
  { value: 'sensitive', labelKey: 'admin.reportDetail.actionSensitive' },
  { value: 'disable', labelKey: 'admin.reportDetail.actionDisable' },
  { value: 'silence', labelKey: 'admin.reportDetail.actionSilence' },
  { value: 'suspend', labelKey: 'admin.reportDetail.actionSuspend' },
]

const isTargetRemote = computed(() => {
  if (!report.value) return false
  return report.value.target_account.acct.includes('@')
})

const categoryBadgeClass = computed(() => {
  if (!report.value) return ''
  switch (report.value.category) {
    case 'spam': return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
    case 'violation': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    case 'legal': return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-400'
  }
})

onMounted(() => {
  loadReport()
})

async function loadReport() {
  loading.value = true
  error.value = null
  try {
    const { data } = await apiFetch<AdminReport>(`/v1/admin/reports/${props.id}`, {
      token: authStore.token ?? undefined,
    })
    report.value = data
    // Load warnings for target account
    loadWarnings(data.target_account.id)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function loadWarnings(accountId: string) {
  try {
    const { data } = await apiFetch<AccountWarning[]>(`/v1/admin/accounts/${accountId}/warnings`, {
      token: authStore.token ?? undefined,
    })
    warnings.value = data
  } catch {
    // Warnings endpoint may not exist; silently ignore
    warnings.value = []
  }
}

async function deleteStatus(statusId: string) {
  if (!confirm(t('admin.reportDetail.deleteStatusConfirm'))) return
  try {
    await apiFetch(`/v1/admin/statuses/${statusId}`, {
      method: 'DELETE',
      token: authStore.token ?? undefined,
    })
    // Reload report to refresh status list
    await loadReport()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function handleActionAndResolve() {
  if (!report.value) return
  submitting.value = true
  error.value = null
  try {
    if (actionType.value !== 'none') {
      await apiFetch(`/v1/admin/accounts/${report.value.target_account.id}/action`, {
        method: 'POST',
        token: authStore.token ?? undefined,
        body: {
          type: actionType.value,
          text: actionText.value,
          report_id: report.value.id,
          send_email_notification: !isTargetRemote.value && sendEmail.value,
        },
      })
    }
    await apiFetch(`/v1/admin/reports/${report.value.id}/resolve`, {
      method: 'POST',
      token: authStore.token ?? undefined,
    })
    router.push('/admin/reports')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    submitting.value = false
  }
}

async function handleDismissAndResolve() {
  if (!report.value) return
  submitting.value = true
  error.value = null
  try {
    await apiFetch(`/v1/admin/reports/${report.value.id}/resolve`, {
      method: 'POST',
      token: authStore.token ?? undefined,
    })
    router.push('/admin/reports')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    submitting.value = false
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function actionBadgeClass(action: string) {
  switch (action) {
    case 'warn': return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    case 'silence':
    case 'sensitive': return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
    case 'disable':
    case 'suspend': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-400'
  }
}
</script>

<template>
  <AdminLayout>
  <div class="w-full max-w-4xl">
    <!-- Header -->
    <div class="flex items-center gap-3 mb-6">
      <button
        @click="router.push('/admin/reports')"
        class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-gray-600 dark:text-gray-400"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd" />
        </svg>
      </button>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">
        {{ t('admin.reportDetail.title') }} #{{ id }}
      </h1>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
      {{ error }}
    </div>

    <LoadingSpinner v-if="loading" />

    <template v-else-if="report">
      <!-- Report Info Card -->
      <div class="p-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 mb-6">
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <span class="text-sm font-medium text-gray-500 dark:text-gray-400">ID: {{ report.id }}</span>
          <span
            class="px-2 py-0.5 rounded-full text-xs font-medium"
            :class="categoryBadgeClass"
          >
            {{ t('admin.reportDetail.category_' + report.category) }}
          </span>
          <span
            class="px-2 py-0.5 rounded-full text-xs font-medium"
            :class="report.action_taken
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
            "
          >
            {{ report.action_taken ? t('admin.reportStatus.resolved') : t('admin.reportStatus.open') }}
          </span>
          <span v-if="report.forwarded" class="px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 font-medium">
            {{ t('admin.reportDetail.forwarded') }}
          </span>
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-1">
          {{ t('admin.reportDetail.date') }}: {{ formatDate(report.created_at) }}
        </p>
        <p v-if="report.comment" class="text-sm text-gray-700 dark:text-gray-300 mt-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-900/50">
          {{ report.comment }}
        </p>
      </div>

      <!-- Reporter / Target Account -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <!-- Reporter -->
        <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <h3 class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
            {{ t('admin.reportDetail.reporter') }}
          </h3>
          <div class="flex items-center gap-3">
            <img
              :src="report.account.avatar"
              :alt="report.account.username"
              class="w-10 h-10 rounded-full object-cover"
            />
            <div class="min-w-0">
              <p class="text-sm font-medium text-gray-900 dark:text-white truncate">
                {{ report.account.display_name || report.account.username }}
              </p>
              <router-link
                :to="'/@' + report.account.acct"
                class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                @{{ report.account.acct }}
              </router-link>
            </div>
          </div>
        </div>

        <!-- Target -->
        <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <h3 class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
            {{ t('admin.reportDetail.targetAccount') }}
          </h3>
          <div class="flex items-center gap-3">
            <img
              :src="report.target_account.avatar"
              :alt="report.target_account.username"
              class="w-10 h-10 rounded-full object-cover"
            />
            <div class="min-w-0">
              <p class="text-sm font-medium text-gray-900 dark:text-white truncate">
                {{ report.target_account.display_name || report.target_account.username }}
              </p>
              <router-link
                :to="'/@' + report.target_account.acct"
                class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                @{{ report.target_account.acct }}
              </router-link>
            </div>
          </div>
        </div>
      </div>

      <!-- Reported Statuses -->
      <div class="mb-6">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          {{ t('admin.reportDetail.reportedStatuses') }}
        </h2>
        <div v-if="report.statuses.length === 0" class="p-4 text-center text-sm text-gray-500 dark:text-gray-400 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          {{ t('admin.reportDetail.noStatuses') }}
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="status in report.statuses"
            :key="status.id"
            class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
          >
            <div class="prose prose-sm dark:prose-invert max-w-none mb-2" v-html="status.content" />
            <div class="flex items-center justify-between mt-3">
              <span class="text-xs text-gray-400">{{ formatDate(status.created_at) }}</span>
              <div>
                <span v-if="!status.url && !status.content" class="px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 font-medium">
                  {{ t('admin.reportDetail.deleted') }}
                </span>
                <button
                  v-else
                  @click="deleteStatus(status.id)"
                  class="px-3 py-1 rounded-lg text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                >
                  {{ t('common.delete') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Warning History -->
      <div class="mb-6">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          {{ t('admin.reportDetail.warningHistory') }}
        </h2>
        <div class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div v-if="warnings.length === 0" class="text-center text-sm text-gray-500 dark:text-gray-400 py-4">
            {{ t('admin.reportDetail.noWarnings') }}
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="warning in warnings"
              :key="warning.id"
              class="flex items-start gap-3 pb-3 border-b border-gray-100 dark:border-gray-700/50 last:border-0 last:pb-0"
            >
              <span
                class="px-2 py-0.5 rounded-full text-xs font-medium shrink-0 mt-0.5"
                :class="actionBadgeClass(warning.action)"
              >
                {{ t('admin.reportDetail.action_' + warning.action) }}
              </span>
              <div class="min-w-0 flex-1">
                <p v-if="warning.text" class="text-sm text-gray-700 dark:text-gray-300">{{ warning.text }}</p>
                <p class="text-xs text-gray-400 mt-1">{{ formatDate(warning.created_at) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Action Form (only if not resolved) -->
      <div v-if="!report.action_taken" class="p-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {{ t('admin.reportDetail.takeAction') }}
        </h2>

        <!-- Action type radio -->
        <div class="mb-4">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {{ t('admin.reportDetail.actionType') }}
          </label>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <label
              v-for="at in actionTypes"
              :key="at.value"
              class="flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors"
              :class="actionType === at.value
                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                : 'border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              "
            >
              <input
                v-model="actionType"
                type="radio"
                :value="at.value"
                class="text-indigo-600 focus:ring-indigo-500"
              />
              <span class="text-sm text-gray-700 dark:text-gray-300">{{ t(at.labelKey) }}</span>
            </label>
          </div>
        </div>

        <!-- Reason textarea -->
        <div class="mb-4">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {{ t('admin.reportDetail.reason') }}
          </label>
          <textarea
            v-model="actionText"
            rows="3"
            class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            :placeholder="t('admin.reportDetail.reasonPlaceholder')"
          />
        </div>

        <!-- Email notification checkbox (hidden for remote accounts) -->
        <div v-if="!isTargetRemote" class="mb-6">
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              v-model="sendEmail"
              type="checkbox"
              class="rounded text-indigo-600 focus:ring-indigo-500"
            />
            <span class="text-sm text-gray-700 dark:text-gray-300">
              {{ t('admin.reportDetail.sendEmailNotification') }}
            </span>
          </label>
        </div>

        <!-- Buttons -->
        <div class="flex flex-wrap gap-3">
          <button
            @click="handleActionAndResolve"
            :disabled="submitting"
            class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50"
          >
            {{ submitting ? t('common.loading') : t('admin.reportDetail.actionAndResolve') }}
          </button>
          <button
            @click="handleDismissAndResolve"
            :disabled="submitting"
            class="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            {{ t('admin.reportDetail.dismissAndResolve') }}
          </button>
        </div>
      </div>
    </template>
  </div>
  </AdminLayout>
</template>
