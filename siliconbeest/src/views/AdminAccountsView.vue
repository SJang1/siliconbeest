<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { getAdminAccounts, changeRole, sendAdminEmail } from '@/api/mastodon/admin'
import { apiFetch } from '@/api/client'
import AdminLayout from '@/components/layout/AdminLayout.vue'

const { t } = useI18n()
const auth = useAuthStore()

interface AdminAccount {
  id: string
  username: string
  email: string
  role: string | { name: string } | null
  domain: string | null
  created_at: string
  disabled: boolean
  approved: boolean
  silenced: boolean
  suspended: boolean
  confirmed: boolean
  invite_request: string | null
}

const accounts = ref<AdminAccount[]>([])
const loading = ref(true)
const error = ref('')
const filter = ref<'all' | 'local' | 'remote' | 'pending'>('all')
const actionMessage = ref('')
const searchQuery = ref('')
const hasMore = ref(false)
const loadingMore = ref(false)
const PAGE_SIZE = 40

// Email modal state
const emailModalOpen = ref(false)
const emailTarget = ref<AdminAccount | null>(null)
const emailSubject = ref('')
const emailBody = ref('')
const emailSending = ref(false)

onMounted(() => loadAccounts())

function buildParams(extra?: Record<string, string>): Record<string, string> {
  const params: Record<string, string> = { limit: String(PAGE_SIZE) }
  if (filter.value === 'local') params.local = 'true'
  if (filter.value === 'remote') params.remote = 'true'
  if (filter.value === 'pending') params.pending = 'true'
  const q = searchQuery.value.trim()
  if (q) {
    // Search by username and email simultaneously
    if (q.includes('@')) {
      params.email = q
    } else {
      params.username = q
    }
  }
  if (extra) Object.assign(params, extra)
  return params
}

async function loadAccounts() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await getAdminAccounts(auth.token!, buildParams())
    accounts.value = data as AdminAccount[]
    hasMore.value = (data as AdminAccount[]).length >= PAGE_SIZE
  } catch (e: any) {
    error.value = e?.description || e?.error || t('common.error')
  } finally {
    loading.value = false
  }
}

async function loadNextPage() {
  if (loadingMore.value || !hasMore.value || accounts.value.length === 0) return
  loadingMore.value = true
  try {
    const lastAccount = accounts.value[accounts.value.length - 1]
    if (!lastAccount) return
    const lastId = lastAccount.id
    const { data } = await getAdminAccounts(auth.token!, buildParams({ max_id: lastId }))
    const newAccounts = data as AdminAccount[]
    accounts.value.push(...newAccounts)
    hasMore.value = newAccounts.length >= PAGE_SIZE
  } catch (e: any) {
    error.value = e?.description || e?.error || t('common.error')
  } finally {
    loadingMore.value = false
  }
}

function handleSearch() {
  loadAccounts()
}

async function handleRoleChange(account: AdminAccount, newRole: string) {
  actionMessage.value = ''
  try {
    await changeRole(auth.token!, account.id, newRole)
    account.role = newRole
    actionMessage.value = t('admin_accounts.role_changed')
  } catch (e: any) {
    actionMessage.value = e?.description || e?.error || t('common.error')
  }
}

async function handleAction(account: AdminAccount, action: string) {
  actionMessage.value = ''
  try {
    // silence/suspend/disable/warn/sensitive use the /action endpoint with a body
    const moderationActions = ['silence', 'suspend', 'disable', 'warn', 'sensitive']
    if (moderationActions.includes(action)) {
      await apiFetch(`/v1/admin/accounts/${account.id}/action`, {
        method: 'POST',
        token: auth.token!,
        body: JSON.stringify({ type: action }),
      })
    } else {
      await apiFetch(`/v1/admin/accounts/${account.id}/${action}`, {
        method: 'POST',
        token: auth.token!,
      })
    }
    if (action === 'approve') {
      account.approved = true
      if (filter.value === 'pending') {
        accounts.value = accounts.value.filter((a) => a.id !== account.id)
      }
      actionMessage.value = t('admin_accounts.approved')
    } else if (action === 'reject') {
      accounts.value = accounts.value.filter((a) => a.id !== account.id)
      actionMessage.value = t('admin_accounts.rejected')
    } else if (action === 'unsuspend') {
      actionMessage.value = t('admin_accounts.unsuspended')
      await loadAccounts()
    } else if (action === 'unsilence') {
      actionMessage.value = t('admin_accounts.unsilenced')
      await loadAccounts()
    } else if (action === 'enable') {
      actionMessage.value = t('admin_accounts.enabled')
      await loadAccounts()
    } else if (action === 'unsensitize') {
      actionMessage.value = t('admin_accounts.unsensitized')
      await loadAccounts()
    } else if (action === 'silence') {
      actionMessage.value = t('admin_accounts.silenced')
      await loadAccounts()
    } else if (action === 'suspend') {
      actionMessage.value = t('admin_accounts.suspended')
      await loadAccounts()
    } else if (action === 'disable') {
      actionMessage.value = t('admin_accounts.disabled')
      await loadAccounts()
    } else {
      await loadAccounts()
    }
  } catch (e: any) {
    actionMessage.value = e?.description || e?.error || t('common.error')
  }
}

function openEmailModal(account: AdminAccount) {
  emailTarget.value = account
  emailSubject.value = ''
  emailBody.value = ''
  emailModalOpen.value = true
}

async function handleSendEmail() {
  if (!emailTarget.value) return
  emailSending.value = true
  try {
    await sendAdminEmail(auth.token!, emailTarget.value.email, emailSubject.value, emailBody.value)
    emailModalOpen.value = false
  } catch (e: any) {
    actionMessage.value = e?.description || e?.error || t('common.error')
  } finally {
    emailSending.value = false
  }
}

function changeFilter(f: 'all' | 'local' | 'remote' | 'pending') {
  filter.value = f
  loadAccounts()
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString()
}

function statusBadge(account: AdminAccount) {
  if (account.suspended) return { text: t('admin_accounts.status_suspended'), color: 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300' }
  if (account.silenced) return { text: t('admin_accounts.status_silenced'), color: 'bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300' }
  if (!account.approved) return { text: t('admin_accounts.status_pending'), color: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300' }
  if (account.disabled) return { text: t('admin_accounts.status_disabled'), color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }
  return { text: t('admin_accounts.status_active'), color: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' }
}

const tabClass = (active: boolean) =>
  active
    ? 'rounded-full px-4 py-1.5 text-sm font-medium bg-brand-600 text-white shadow-soft transition-colors dark:bg-brand-500'
    : 'rounded-full px-4 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-surface-2 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-surface-2-dark dark:hover:text-white'

const inputClass = 'sb-input'
</script>

<template>
  <AdminLayout>
  <div class="w-full max-w-6xl animate-fade-in">
    <h1 class="sb-heading mb-6 text-2xl text-slate-900 dark:text-white">{{ t('admin.accounts') }}</h1>

    <!-- Search -->
    <form @submit.prevent="handleSearch" class="mb-4">
      <div class="flex gap-2">
        <input
          v-model="searchQuery"
          type="text"
          :placeholder="t('admin_accounts.search_placeholder')"
          class="sb-input flex-1"
        />
        <button
          type="submit"
          class="sb-btn sb-btn-primary shrink-0"
        >
          {{ t('common.search') }}
        </button>
      </div>
    </form>

    <!-- Filter tabs -->
    <div class="mb-4 inline-flex gap-1 rounded-full border border-outline bg-surface p-1 shadow-soft dark:border-outline-dark dark:bg-surface-dark">
      <button :class="tabClass(filter === 'all')" @click="changeFilter('all')">{{ t('admin_accounts.filter_all') }}</button>
      <button :class="tabClass(filter === 'local')" @click="changeFilter('local')">{{ t('admin_accounts.filter_local') }}</button>
      <button :class="tabClass(filter === 'remote')" @click="changeFilter('remote')">{{ t('admin_accounts.filter_remote') }}</button>
      <button :class="tabClass(filter === 'pending')" @click="changeFilter('pending')">{{ t('admin_accounts.filter_pending') }}</button>
    </div>

    <!-- Messages -->
    <div v-if="actionMessage" class="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
      {{ actionMessage }}
    </div>
    <div v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300" role="alert">
      {{ error }}
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-sm text-slate-500 dark:text-slate-400">{{ t('common.loading') }}</div>

    <!-- Table -->
    <div v-else class="sb-card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left">
              <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400">{{ t('auth.username') }}</th>
              <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400">{{ t('auth.email') }}</th>
              <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400">{{ t('admin_accounts.role') }}</th>
              <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400">{{ t('admin_accounts.status') }}</th>
              <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400">{{ t('admin_accounts.created') }}</th>
              <th class="sticky top-0 z-10 border-b border-outline bg-surface-2 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-400">{{ t('admin_accounts.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="account in accounts"
              :key="account.id"
              class="border-b border-outline transition-colors last:border-0 hover:bg-surface-2/70 dark:border-outline-dark dark:hover:bg-surface-2-dark/70"
            >
              <td class="px-4 py-3">
                <div class="font-medium text-slate-900 dark:text-white">
                  {{ account.username }}
                  <span v-if="account.domain" class="font-normal text-slate-400 dark:text-slate-500">@{{ account.domain }}</span>
                </div>
                <div v-if="!account.approved && account.invite_request" class="mt-1 rounded-lg bg-surface-2 px-2 py-1 text-xs text-slate-500 dark:bg-surface-2-dark dark:text-slate-400">
                  <span class="font-medium text-slate-600 dark:text-slate-300">{{ t('auth.signup_reason') }}</span>
                  {{ account.invite_request }}
                </div>
              </td>
              <td class="px-4 py-3 text-slate-600 dark:text-slate-400">{{ account.email || '-' }}</td>
              <td class="px-4 py-3">
                <select
                  :value="typeof account.role === 'string' ? account.role : (account.role?.name || 'user')"
                  @change="handleRoleChange(account, ($event.target as HTMLSelectElement).value)"
                  class="rounded-lg border border-outline bg-surface px-2 py-1 text-sm text-slate-900 transition focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-100"
                >
                  <option value="user">user</option>
                  <option value="moderator">moderator</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td class="px-4 py-3">
                <span class="sb-chip" :class="statusBadge(account).color">
                  {{ statusBadge(account).text }}
                </span>
              </td>
              <td class="px-4 py-3 text-slate-600 dark:text-slate-400">{{ formatDate(account.created_at) }}</td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <template v-if="!account.approved">
                    <button
                      @click="handleAction(account, 'approve')"
                      class="sb-btn sb-btn-sm bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-950/80"
                    >
                      {{ t('admin_accounts.approve') }}
                    </button>
                    <button
                      @click="handleAction(account, 'reject')"
                      class="sb-btn sb-btn-sm bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-950/80"
                    >
                      {{ t('admin_accounts.reject') }}
                    </button>
                  </template>
                  <template v-else>
                    <button
                      v-if="account.suspended"
                      @click="handleAction(account, 'unsuspend')"
                      class="sb-btn sb-btn-sm bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-950/80"
                    >
                      {{ t('admin_accounts.unsuspend') }}
                    </button>
                    <button
                      v-if="account.silenced"
                      @click="handleAction(account, 'unsilence')"
                      class="sb-btn sb-btn-sm bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-950/80"
                    >
                      {{ t('admin_accounts.unsilence') }}
                    </button>
                    <button
                      v-if="account.disabled"
                      @click="handleAction(account, 'enable')"
                      class="sb-btn sb-btn-sm bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-950/80"
                    >
                      {{ t('admin_accounts.enable') }}
                    </button>
                    <button
                      v-if="!account.silenced && !account.suspended"
                      @click="handleAction(account, 'silence')"
                      class="sb-btn sb-btn-sm bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/50 dark:text-amber-300 dark:hover:bg-amber-950/80"
                    >
                      {{ t('admin.accountAction.silence') }}
                    </button>
                    <button
                      v-if="!account.suspended"
                      @click="handleAction(account, 'suspend')"
                      class="sb-btn sb-btn-sm bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-950/80"
                    >
                      {{ t('admin.accountAction.suspend') }}
                    </button>
                  </template>
                  <button
                    v-if="account.email"
                    @click="openEmailModal(account)"
                    class="sb-btn sb-btn-sm bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-950/50 dark:text-brand-300 dark:hover:bg-brand-950/80"
                  >
                    {{ t('admin_accounts.send_email') }}
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="accounts.length === 0">
              <td colspan="6" class="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">{{ t('admin_accounts.no_accounts') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Load More -->
    <div v-if="hasMore && !loading" class="mt-4 flex justify-center">
      <button
        @click="loadNextPage"
        :disabled="loadingMore"
        class="sb-btn sb-btn-secondary px-6"
      >
        {{ loadingMore ? t('common.loading') : t('common.load_more') }}
      </button>
    </div>

    <!-- Email Modal -->
    <Teleport to="body">
      <div v-if="emailModalOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" @click.self="emailModalOpen = false">
        <div class="sb-card mx-4 w-full max-w-md p-6 shadow-lift animate-rise-in">
          <h3 class="sb-heading mb-4 text-lg text-slate-900 dark:text-white">
            {{ t('admin_accounts.send_email') }} - {{ emailTarget?.username }}
          </h3>
          <form @submit.prevent="handleSendEmail" class="space-y-4">
            <div>
              <label class="sb-label">{{ t('admin_accounts.email_to') }}</label>
              <input :value="emailTarget?.email" disabled :class="inputClass" class="!bg-surface-2 opacity-70 dark:!bg-canvas-dark" />
            </div>
            <div>
              <label class="sb-label">{{ t('admin_accounts.email_subject') }}</label>
              <input v-model="emailSubject" required :class="inputClass" />
            </div>
            <div>
              <label class="sb-label">{{ t('admin_accounts.email_body') }}</label>
              <textarea v-model="emailBody" required rows="5" :class="inputClass" />
            </div>
            <div class="flex justify-end gap-3">
              <button
                type="button"
                @click="emailModalOpen = false"
                class="sb-btn sb-btn-secondary"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                type="submit"
                :disabled="emailSending"
                class="sb-btn sb-btn-primary"
              >
                {{ emailSending ? t('common.loading') : t('admin_accounts.send_email') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </div>
  </AdminLayout>
</template>
