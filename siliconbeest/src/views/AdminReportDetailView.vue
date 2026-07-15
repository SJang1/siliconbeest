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
const contributionPoints = ref<number | null>(null)
const contributionReason = ref('')

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
    case 'spam': return 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
    case 'violation': return 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
    case 'legal': return 'bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300'
    default: return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
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

function contributionResolutionBody() {
  const points = contributionPoints.value
  if (!report.value || points === null || !Number.isSafeInteger(points) || points === 0) return {}
  return {
    contribution_adjustment: {
      account_id: report.value.target_account.id,
      points,
      reason: contributionReason.value.trim() || undefined,
    },
  }
}

function setContributionPoints(event: Event) {
  const value = (event.target as HTMLInputElement).value
  contributionPoints.value = value === '' ? null : Number(value)
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
      body: contributionResolutionBody(),
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
      body: contributionResolutionBody(),
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
    case 'warn': return 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
    case 'silence':
    case 'sensitive': return 'bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300'
    case 'disable':
    case 'suspend': return 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
    default: return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
  }
}
</script>

<template>
  <AdminLayout>
  <div class="w-full max-w-5xl animate-fade-in">
    <!-- Header -->
    <div class="mb-6 flex items-center gap-3">
      <button
        @click="router.push('/admin/reports')"
        class="rounded-full p-2 text-slate-600 transition-colors hover:bg-surface-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-surface-2-dark dark:hover:text-white"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd" />
        </svg>
      </button>
      <h1 class="sb-heading text-2xl text-slate-900 dark:text-white">
        {{ t('admin.reportDetail.title') }} #{{ id }}
      </h1>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
      {{ error }}
    </div>

    <LoadingSpinner v-if="loading" />

    <template v-else-if="report">
      <!-- Report Info Card -->
      <div class="sb-card mb-6 p-5">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium text-slate-500 dark:text-slate-400">ID: {{ report.id }}</span>
          <span
            class="sb-chip"
            :class="categoryBadgeClass"
          >
            {{ t('admin.reportDetail.category_' + report.category) }}
          </span>
          <span
            class="sb-chip"
            :class="report.action_taken
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
              : 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
            "
          >
            {{ report.action_taken ? t('admin.reportStatus.resolved') : t('admin.reportStatus.open') }}
          </span>
          <span v-if="report.forwarded" class="sb-chip bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
            {{ t('admin.reportDetail.forwarded') }}
          </span>
        </div>
        <p class="mb-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('admin.reportDetail.date') }}: {{ formatDate(report.created_at) }}
        </p>
        <p v-if="report.comment" class="mt-3 rounded-xl bg-surface-2 p-3 text-sm text-slate-700 dark:bg-surface-2-dark dark:text-slate-300">
          {{ report.comment }}
        </p>
      </div>

      <!-- Reporter / Target Account -->
      <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <!-- Reporter -->
        <div class="sb-card p-4">
          <h3 class="sb-label mb-3">
            {{ t('admin.reportDetail.reporter') }}
          </h3>
          <div class="flex items-center gap-3">
            <img
              :src="report.account.avatar"
              :alt="report.account.username"
              class="h-10 w-10 rounded-full object-cover"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-slate-900 dark:text-white">
                {{ report.account.display_name || report.account.username }}
              </p>
              <router-link
                :to="'/@' + report.account.acct"
                class="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                @{{ report.account.acct }}
              </router-link>
            </div>
          </div>
        </div>

        <!-- Target -->
        <div class="sb-card p-4">
          <h3 class="sb-label mb-3">
            {{ t('admin.reportDetail.targetAccount') }}
          </h3>
          <div class="flex items-center gap-3">
            <img
              :src="report.target_account.avatar"
              :alt="report.target_account.username"
              class="h-10 w-10 rounded-full object-cover"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-slate-900 dark:text-white">
                {{ report.target_account.display_name || report.target_account.username }}
              </p>
              <router-link
                :to="'/@' + report.target_account.acct"
                class="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                @{{ report.target_account.acct }}
              </router-link>
            </div>
          </div>
        </div>
      </div>

      <!-- Reported Statuses -->
      <div class="mb-6">
        <h2 class="sb-heading mb-3 text-lg text-slate-900 dark:text-white">
          {{ t('admin.reportDetail.reportedStatuses') }}
        </h2>
        <div v-if="report.statuses.length === 0" class="sb-card p-4 text-center text-sm text-slate-500 dark:text-slate-400">
          {{ t('admin.reportDetail.noStatuses') }}
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="status in report.statuses"
            :key="status.id"
            class="sb-card p-4"
          >
            <div class="prose pred-sm dark:pred-invert mb-2 max-w-none" v-html="status.content" />
            <div class="mt-3 flex items-center justify-between">
              <span class="text-xs text-slate-400 dark:text-slate-500">{{ formatDate(status.created_at) }}</span>
              <div>
                <span v-if="!status.url && !status.content" class="sb-chip bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300">
                  {{ t('admin.reportDetail.deleted') }}
                </span>
                <button
                  v-else
                  @click="deleteStatus(status.id)"
                  class="sb-btn sb-btn-sm bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-950/80"
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
        <h2 class="sb-heading mb-3 text-lg text-slate-900 dark:text-white">
          {{ t('admin.reportDetail.warningHistory') }}
        </h2>
        <div class="sb-card p-4">
          <div v-if="warnings.length === 0" class="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
            {{ t('admin.reportDetail.noWarnings') }}
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="warning in warnings"
              :key="warning.id"
              class="flex items-start gap-3 border-b border-outline pb-3 last:border-0 last:pb-0 dark:border-outline-dark"
            >
              <span
                class="sb-chip mt-0.5 shrink-0"
                :class="actionBadgeClass(warning.action)"
              >
                {{ t('admin.reportDetail.action_' + warning.action) }}
              </span>
              <div class="min-w-0 flex-1">
                <p v-if="warning.text" class="text-sm text-slate-700 dark:text-slate-300">{{ warning.text }}</p>
                <p class="mt-1 text-xs text-slate-400 dark:text-slate-500">{{ formatDate(warning.created_at) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Action Form (only if not resolved) -->
      <div v-if="!report.action_taken" class="sb-card p-6">
        <h2 class="sb-heading mb-4 text-lg text-slate-900 dark:text-white">
          {{ t('admin.reportDetail.takeAction') }}
        </h2>

        <!-- Action type radio -->
        <div class="mb-4">
          <label class="sb-label mb-2">
            {{ t('admin.reportDetail.actionType') }}
          </label>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <label
              v-for="at in actionTypes"
              :key="at.value"
              class="flex cursor-pointer items-center gap-2 rounded-xl border p-2.5 transition-colors"
              :class="actionType === at.value
                ? 'border-brand-400 bg-brand-50 dark:border-brand-600 dark:bg-brand-950/40'
                : 'border-outline hover:bg-surface-2 dark:border-outline-dark dark:hover:bg-surface-2-dark'
              "
            >
              <input
                v-model="actionType"
                type="radio"
                :value="at.value"
                class="h-4 w-4 accent-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:accent-brand-500"
              />
              <span class="text-sm text-slate-700 dark:text-slate-300">{{ t(at.labelKey) }}</span>
            </label>
          </div>
        </div>

        <!-- Reason textarea -->
        <div class="mb-4">
          <label class="sb-label">
            {{ t('admin.reportDetail.reason') }}
          </label>
          <textarea
            v-model="actionText"
            rows="3"
            class="sb-input"
            :placeholder="t('admin.reportDetail.reasonPlaceholder')"
          />
        </div>

        <!-- Email notification checkbox (hidden for remote accounts) -->
        <div v-if="!isTargetRemote" class="mb-6">
          <label class="flex cursor-pointer items-center gap-2">
            <input
              v-model="sendEmail"
              type="checkbox"
              class="h-4 w-4 rounded accent-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:accent-brand-500"
            />
            <span class="text-sm text-slate-700 dark:text-slate-300">
              {{ t('admin.reportDetail.sendEmailNotification') }}
            </span>
          </label>
        </div>

        <fieldset v-if="!isTargetRemote" class="mb-6 rounded-xl border border-outline p-4 dark:border-outline-dark">
          <legend class="px-1 text-sm font-semibold text-slate-900 dark:text-white">
            {{ t('admin.reportDetail.contributionAdjustment') }}
          </legend>
          <p class="mb-3 text-xs text-slate-500 dark:text-slate-400">
            {{ t('admin.reportDetail.contributionAdjustmentHelp') }}
          </p>
          <div class="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <label class="block">
              <span class="sb-label">{{ t('admin.reportDetail.contributionPoints') }}</span>
              <input
                :value="contributionPoints ?? ''"
                class="sb-input"
                type="number"
                step="1"
                :placeholder="t('admin.reportDetail.contributionPointsPlaceholder')"
                @input="setContributionPoints"
              />
            </label>
            <label class="block">
              <span class="sb-label">{{ t('admin.reportDetail.contributionReason') }}</span>
              <input v-model="contributionReason" class="sb-input" maxlength="500" />
            </label>
          </div>
        </fieldset>

        <!-- Buttons -->
        <div class="flex flex-wrap gap-3">
          <button
            @click="handleActionAndResolve"
            :disabled="submitting"
            class="sb-btn sb-btn-primary"
          >
            {{ submitting ? t('common.loading') : t('admin.reportDetail.actionAndResolve') }}
          </button>
          <button
            @click="handleDismissAndResolve"
            :disabled="submitting"
            class="sb-btn sb-btn-secondary"
          >
            {{ t('admin.reportDetail.dismissAndResolve') }}
          </button>
        </div>
      </div>
    </template>
  </div>
  </AdminLayout>
</template>
