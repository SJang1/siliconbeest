<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import {
  adjustAdminInvitationCredits,
  distributeAdminInvitationCredits,
  getAdminInvitationCredits,
  resetAdminInvitationCredits,
} from '@/api/mastodon/invitations'
import { getApiErrorMessage } from '@/utils/apiError'
import { withCurrentDesign } from '@/utils/safeRedirect'
import type {
  AdminInvitationCreditAccount,
  InvitationCreditOperation,
} from '@/types/registration'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const PAGE_SIZE = 25

const accounts = ref<AdminInvitationCreditAccount[]>([])
const total = ref(0)
const offset = ref(0)
const search = ref('')
const selectedIds = ref<string[]>([])
const loading = ref(true)
const submitting = ref(false)
const error = ref('')
const success = ref('')

const adjustmentTarget = ref<AdminInvitationCreditAccount | null>(null)
const adjustmentOperation = ref<InvitationCreditOperation>('add')
const adjustmentAmount = ref(1)
const adjustmentReason = ref('')

const bulkScope = ref<'all' | 'selected'>('selected')
const bulkAmount = ref(1)
const resetConfirmation = ref('')

const selectedCount = computed(() => selectedIds.value.length)
const allVisibleSelected = computed(() => (
  accounts.value.length > 0
  && accounts.value.every((account) => selectedIds.value.includes(account.account_id))
))
const hasPrevious = computed(() => offset.value > 0)
const hasNext = computed(() => offset.value + accounts.value.length < total.value)

function requestAccountIds(): string[] | undefined {
  return bulkScope.value === 'selected' ? [...selectedIds.value] : undefined
}

function toggleAccount(accountId: string) {
  selectedIds.value = selectedIds.value.includes(accountId)
    ? selectedIds.value.filter((id) => id !== accountId)
    : [...selectedIds.value, accountId]
}

function toggleVisible() {
  const visibleIds = accounts.value.map((account) => account.account_id)
  if (allVisibleSelected.value) {
    selectedIds.value = selectedIds.value.filter((id) => !visibleIds.includes(id))
    return
  }
  selectedIds.value = [...new Set([...selectedIds.value, ...visibleIds])]
}

function clearMessages() {
  error.value = ''
  success.value = ''
}

async function loadAccounts(nextOffset = offset.value) {
  if (!auth.token) return
  loading.value = true
  clearMessages()
  try {
    const { data } = await getAdminInvitationCredits(auth.token, {
      search: search.value.trim() || undefined,
      limit: PAGE_SIZE,
      offset: nextOffset,
    })
    accounts.value = data.accounts
    total.value = data.total
    offset.value = data.offset
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  selectedIds.value = []
  void loadAccounts(0)
}

function beginAdjustment(account: AdminInvitationCreditAccount) {
  adjustmentTarget.value = account
  adjustmentOperation.value = 'add'
  adjustmentAmount.value = 1
  adjustmentReason.value = ''
}

async function submitAdjustment() {
  if (!auth.token || !adjustmentTarget.value || !Number.isFinite(adjustmentAmount.value)) return
  submitting.value = true
  clearMessages()
  try {
    await adjustAdminInvitationCredits(
      auth.token,
      adjustmentTarget.value.account_id,
      {
        operation: adjustmentOperation.value,
        amount: Math.trunc(adjustmentAmount.value),
        reason: adjustmentReason.value.trim() || undefined,
      },
    )
    success.value = t('admin_invitation_credits.adjusted')
    adjustmentTarget.value = null
    await loadAccounts()
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    submitting.value = false
  }
}

async function distributeCredits() {
  const accountIds = requestAccountIds()
  if (!auth.token || bulkAmount.value < 1 || (bulkScope.value === 'selected' && accountIds?.length === 0)) return
  submitting.value = true
  clearMessages()
  try {
    const { data } = await distributeAdminInvitationCredits(auth.token, {
      account_ids: accountIds,
      amount: Math.trunc(bulkAmount.value),
    })
    success.value = t('admin_invitation_credits.distributed', { count: data.updated })
    await loadAccounts()
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    submitting.value = false
  }
}

async function resetCredits() {
  const accountIds = requestAccountIds()
  if (
    !auth.token
    || resetConfirmation.value !== 'RESET'
    || (bulkScope.value === 'selected' && accountIds?.length === 0)
  ) return
  submitting.value = true
  clearMessages()
  try {
    const { data } = await resetAdminInvitationCredits(auth.token, {
      account_ids: accountIds,
      confirmation: 'RESET',
    })
    success.value = t('admin_invitation_credits.reset_complete', { count: data.updated })
    resetConfirmation.value = ''
    await loadAccounts()
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    submitting.value = false
  }
}

onMounted(() => loadAccounts(0))
</script>

<template>
  <div class="w-full max-w-6xl space-y-6">
    <header class="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <div>
        <h1 class="sb-heading text-2xl">{{ t('admin_invitation_credits.title') }}</h1>
        <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {{ t('admin_invitation_credits.description') }}
        </p>
      </div>
      <router-link class="sb-btn sb-btn-secondary shrink-0" :to="withCurrentDesign('/admin/invitation-audit-logs', route.path)">
        {{ t('admin_invitation_credits.view_audit_logs') }}
      </router-link>
    </header>

    <div v-if="error" class="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300" role="alert">
      {{ error }}
    </div>
    <div v-if="success" class="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" role="status">
      {{ success }}
    </div>

    <section class="sb-card p-5">
      <form class="flex flex-col gap-3 sm:flex-row" @submit.prevent="handleSearch">
        <label class="sr-only" for="credit-account-search">{{ t('common.search') }}</label>
        <input
          id="credit-account-search"
          v-model="search"
          class="sb-input flex-1"
          type="search"
          :placeholder="t('admin_invitation_credits.search_placeholder')"
        />
        <button class="sb-btn sb-btn-primary" type="submit">{{ t('common.search') }}</button>
      </form>
    </section>

    <section class="sb-card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] text-left text-sm">
          <thead class="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/70 dark:text-slate-400">
            <tr>
              <th class="px-4 py-3">
                <input
                  type="checkbox"
                  :checked="allVisibleSelected"
                  :aria-label="t('admin_invitation_credits.select_page')"
                  @change="toggleVisible"
                />
              </th>
              <th class="px-4 py-3">{{ t('admin_invitation_credits.account') }}</th>
              <th class="px-4 py-3">{{ t('admin_invitation_credits.balance') }}</th>
              <th class="px-4 py-3">{{ t('admin_invitation_credits.contribution') }}</th>
              <th class="px-4 py-3">{{ t('admin_invitation_credits.actions') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 dark:divide-slate-700">
            <tr v-if="loading">
              <td class="px-4 py-8 text-center text-slate-500" colspan="5">{{ t('common.loading') }}</td>
            </tr>
            <tr v-else-if="accounts.length === 0">
              <td class="px-4 py-8 text-center text-slate-500" colspan="5">{{ t('admin_invitation_credits.empty') }}</td>
            </tr>
            <tr v-for="account in accounts" v-else :key="account.account_id">
              <td class="px-4 py-3">
                <input
                  type="checkbox"
                  :checked="selectedIds.includes(account.account_id)"
                  :aria-label="account.username"
                  @change="toggleAccount(account.account_id)"
                />
              </td>
              <td class="px-4 py-3">
                <div class="font-semibold">{{ account.display_name || account.username }}</div>
                <div class="text-xs text-slate-500">@{{ account.username }} · {{ account.role }}</div>
              </td>
              <td class="px-4 py-3">
                <div class="font-semibold">{{ account.owned_credits }} / {{ account.max_credits }}</div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ t('admin_invitation_credits.balance_breakdown', {
                    available: account.available_credits,
                    reserved: account.reserved_credits,
                    pending: account.pending_refund_credits,
                  }) }}
                </div>
              </td>
              <td class="px-4 py-3">{{ account.contribution_score }}</td>
              <td class="px-4 py-3">
                <button class="sb-btn sb-btn-secondary !px-3 !py-1.5" type="button" @click="beginAdjustment(account)">
                  {{ t('admin_invitation_credits.adjust') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-700">
        <span>{{ t('admin_invitation_credits.total', { count: total }) }}</span>
        <div class="flex gap-2">
          <button class="sb-btn sb-btn-secondary" type="button" :disabled="!hasPrevious || loading" @click="loadAccounts(Math.max(0, offset - PAGE_SIZE))">
            {{ t('common.previous') }}
          </button>
          <button class="sb-btn sb-btn-secondary" type="button" :disabled="!hasNext || loading" @click="loadAccounts(offset + PAGE_SIZE)">
            {{ t('common.next') }}
          </button>
        </div>
      </div>
    </section>

    <section v-if="adjustmentTarget" class="sb-card p-5">
      <h2 class="sb-heading text-lg">
        {{ t('admin_invitation_credits.adjust_account', { username: adjustmentTarget.username }) }}
      </h2>
      <form class="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2fr_auto] md:items-end" @submit.prevent="submitAdjustment">
        <label class="block">
          <span class="sb-label">{{ t('admin_invitation_credits.operation') }}</span>
          <select v-model="adjustmentOperation" class="sb-input">
            <option value="set">{{ t('admin_invitation_credits.operation_set') }}</option>
            <option value="add">{{ t('admin_invitation_credits.operation_add') }}</option>
            <option value="contribution">{{ t('admin_invitation_credits.operation_contribution') }}</option>
          </select>
        </label>
        <label class="block">
          <span class="sb-label">{{ t('admin_invitation_credits.amount') }}</span>
          <input v-model.number="adjustmentAmount" class="sb-input" type="number" step="1" required />
        </label>
        <label class="block">
          <span class="sb-label">{{ t('admin_invitation_credits.reason') }}</span>
          <input v-model="adjustmentReason" class="sb-input" maxlength="500" />
        </label>
        <div class="flex gap-2">
          <button class="sb-btn sb-btn-primary" type="submit" :disabled="submitting">{{ t('common.save') }}</button>
          <button class="sb-btn sb-btn-secondary" type="button" @click="adjustmentTarget = null">{{ t('common.cancel') }}</button>
        </div>
      </form>
    </section>

    <section class="sb-card p-5">
      <h2 class="sb-heading text-lg">{{ t('admin_invitation_credits.bulk_title') }}</h2>
      <div class="mt-4 flex flex-wrap gap-5 text-sm">
        <label class="flex items-center gap-2">
          <input v-model="bulkScope" type="radio" value="selected" />
          {{ t('admin_invitation_credits.selected_accounts', { count: selectedCount }) }}
        </label>
        <label class="flex items-center gap-2">
          <input v-model="bulkScope" type="radio" value="all" />
          {{ t('admin_invitation_credits.all_accounts') }}
        </label>
      </div>
      <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label class="block sm:w-48">
          <span class="sb-label">{{ t('admin_invitation_credits.distribute_amount') }}</span>
          <input v-model.number="bulkAmount" class="sb-input" type="number" min="1" step="1" required />
        </label>
        <button
          class="sb-btn sb-btn-primary"
          type="button"
          :disabled="submitting || bulkAmount < 1 || (bulkScope === 'selected' && selectedCount === 0)"
          @click="distributeCredits"
        >
          {{ t('admin_invitation_credits.distribute') }}
        </button>
      </div>
    </section>

    <section class="rounded-xl border border-red-300 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/30">
      <h2 class="text-lg font-bold text-red-800 dark:text-red-300">{{ t('admin_invitation_credits.danger_title') }}</h2>
      <p class="mt-2 text-sm text-red-700 dark:text-red-400">{{ t('admin_invitation_credits.reset_help') }}</p>
      <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label class="block sm:w-64">
          <span class="mb-1 block text-sm font-semibold text-red-800 dark:text-red-300">{{ t('admin_invitation_credits.type_reset') }}</span>
          <input v-model="resetConfirmation" class="sb-input" autocomplete="off" placeholder="RESET" />
        </label>
        <button
          class="sb-btn bg-red-700 text-white hover:bg-red-800 disabled:opacity-50"
          type="button"
          :disabled="submitting || resetConfirmation !== 'RESET' || (bulkScope === 'selected' && selectedCount === 0)"
          @click="resetCredits"
        >
          {{ t('admin_invitation_credits.reset') }}
        </button>
      </div>
    </section>
  </div>
</template>
